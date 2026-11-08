//! ls's typed values (coreutils 9.7), and the column layouts of `-C`,
//! `-x` and `-m`. Each `--sort`, `--time`, `--hyperlink`, `--color`,
//! `--classify`, `--indicator-style`, `--format`, `--quoting-style`,
//! `--block-size`, `-w` and `-T` is checked where it was typed, so the
//! first bad one names the refusal; `--time-style` is read once the
//! options are, its last value only. The last of `-t -S -X -v -U -f
//! --sort` sets the sort, of `-c -u --time` the time, of `-F --classify -p
//! --file-type --indicator-style` the indicator, of `-l -g -o -n
//! --full-time -1 -C -x -m --format` the format (`-1` leaves a long one
//! long), of `-b -N -Q --quoting-style` the quoting, of `-q
//! --show-control-chars` whether controls print as `?`, and the later of
//! `-h`, `--si` and `--block-size` the size scale. The host sends a bare
//! `--classify`, `--hyperlink` or `--color` as `always`, the word they are
//! read as, and appends `QUOTING_STYLE` and `COLUMNS` as `quoting_env` and
//! `columns_env` when the session sets them: each is read only where no
//! option gives its value, and a bad one is a warning, not a refusal.

use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::number;
use crate::quote::escaped;
use crate::scan::{Typed, Values, unknown};
use crate::width::char_width;
use crate::word::{self, Choice};
use crate::{Stream, StreamError, byte_text, parse_config, quoted};

const SORT: &[Choice] = &[
    &["none"],
    &["size"],
    &["time"],
    &["version"],
    &["extension"],
    &["name"],
    &["width"],
];
const TIME: &[Choice] = &[
    &["atime", "access", "use"],
    &["ctime", "status"],
    &["mtime", "modification"],
    &["birth", "creation"],
];
const WHEN: &[Choice] = &[
    &["always", "yes", "force"],
    &["never", "no", "none"],
    &["auto", "tty", "if-tty"],
];
const INDICATOR: &[Choice] = &[&["none"], &["slash"], &["file-type"], &["classify"]];
const TIME_STYLE: &[Choice] = &[&["full-iso"], &["long-iso"], &["iso"], &["locale"]];
const FORMAT: &[Choice] = &[
    &["verbose", "long"],
    &["commas"],
    &["horizontal", "across"],
    &["vertical"],
    &["single-column"],
];
const QUOTING: &[Choice] = &[
    &["literal"],
    &["shell"],
    &["shell-always"],
    &["shell-escape"],
    &["shell-escape-always"],
    &["c"],
    &["c-maybe"],
    &["escape"],
    &["locale"],
    &["clocale"],
];
/// The width a listing in columns fills when nothing names one.
const LINE_WIDTH: u64 = 80;
/// The tab stops a listing in columns pads with when `-T` names none.
const TAB_SIZE: u64 = 8;
/// The fewest columns a column of `-C` or `-x` takes, its gap included.
const NARROWEST: u64 = 3;
/// Past this a width is wider than any listing, and stays exact in JSON.
const WIDEST: u64 = 1 << 53;

/// The `--time-style` choices as GNU lists them, patterns rather than
/// words.
const TIME_STYLES_LISTED: &str = "Valid arguments are:\n  - [posix-]full-iso\n  \
     - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  \
     - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n\
     Try 'ls --help' for more information.";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let mut sort = Json::Null;
    let mut time = "mtime";
    let mut indicator = "none";
    let mut hyperlink = false;
    let mut block = Json::Null;
    let mut time_style: Option<&[u8]> = None;
    let mut format = "single-column";
    let mut quoting: Option<&str> = None;
    let mut hide_control = false;
    let mut width: Option<Option<u64>> = None;
    let mut tabsize = TAB_SIZE;
    let mut warnings: Vec<String> = Vec::new();
    for (name, raw) in options {
        match name.as_str() {
            "sort" => sort = Json::from(word::choose("ls", "--sort", raw, SORT, 1)?),
            "t" => sort = json!("time"),
            "S" => sort = json!("size"),
            "X" => sort = json!("extension"),
            "v" => sort = json!("version"),
            "U" | "f" => sort = json!("none"),
            "args_l" | "g" | "o" | "numeric_uid_gid" => format = "verbose",
            "full_time" => {
                format = "verbose";
                time_style = Some(b"full-iso");
            }
            "args_1" if format != "verbose" => format = "single-column",
            "args_1" => {}
            "C" => format = "vertical",
            "x" => format = "horizontal",
            "m" => format = "commas",
            "format" => format = word::choose("ls", "--format", raw, FORMAT, 1)?,
            "quoting_style" => {
                quoting = Some(word::choose("ls", "--quoting-style", raw, QUOTING, 1)?);
            }
            "escape" => quoting = Some("escape"),
            "literal" => quoting = Some("literal"),
            "quote_name" => quoting = Some("c"),
            "quoting_env" => {
                if quoting.is_none() {
                    match word::matched(raw, QUOTING) {
                        Ok(style) => quoting = Some(style),
                        Err(_) => warnings.push(format!(
                            "ls: ignoring invalid value of environment variable \
                             QUOTING_STYLE: '{}'",
                            quoted(raw)
                        )),
                    }
                }
            }
            "hide_control_chars" => hide_control = true,
            "show_control_chars" => hide_control = false,
            "width" => {
                let wide = line_width(raw).ok_or_else(|| {
                    StreamError::refusal(
                        format!("ls: invalid line width: '{}'", quoted(raw)).as_bytes(),
                        2,
                    )
                })?;
                width = Some(wide);
            }
            "columns_env" => {
                let laid_out = matches!(format, "vertical" | "horizontal" | "commas");
                if width.is_none() && laid_out && !raw.is_empty() {
                    match line_width(raw) {
                        Some(wide) => width = Some(wide),
                        None => warnings.push(format!(
                            "ls: ignoring invalid width in environment variable COLUMNS: '{}'",
                            quoted(raw)
                        )),
                    }
                }
            }
            "tabsize" => tabsize = tab_size(raw)?,
            "si" => block = crate::block_size::parse(b"si", "ls", "--si", 2, false)?,
            "time" => time = word::choose("ls", "--time", raw, TIME, 1)?,
            "c" => time = "ctime",
            "u" => time = "atime",
            "hyperlink" => hyperlink = word::choose("ls", "--hyperlink", raw, WHEN, 1)? == "always",
            "color" => {
                word::choose("ls", "--color", raw, WHEN, 1)?;
            }
            "classify" => {
                let when = word::choose("ls", "--classify", raw, WHEN, 1)?;
                indicator = if when == "always" { "classify" } else { "none" };
            }
            "indicator_style" => {
                indicator = word::choose("ls", "--indicator-style", raw, INDICATOR, 1)?;
            }
            "p" => indicator = "slash",
            "file_type" => indicator = "file-type",
            "block_size" => block = crate::block_size::parse(raw, "ls", "--block-size", 2, false)?,
            "human_readable" => block = Json::Null,
            "time_style" => time_style = Some(raw),
            _ => return Err(unknown("ls", name)),
        }
    }
    let mut values = Values::new();
    values.insert("sort".to_owned(), sort);
    values.insert("time".to_owned(), json!(time));
    values.insert("indicator".to_owned(), json!(indicator));
    values.insert("hyperlink".to_owned(), json!(hyperlink));
    values.insert("block_size".to_owned(), block);
    values.insert(
        "time_style".to_owned(),
        json!(time_style.map_or(Ok("locale".to_owned()), style)?),
    );
    values.insert("format".to_owned(), json!(format));
    values.insert("quoting".to_owned(), json!(quoting.unwrap_or("literal")));
    values.insert("hide_control".to_owned(), json!(hide_control));
    values.insert("width".to_owned(), json!(width.unwrap_or(Some(LINE_WIDTH))));
    values.insert("tabsize".to_owned(), json!(tabsize));
    values.insert("warnings".to_owned(), json!(warnings));
    Ok(values)
}

/// `-w` or `COLUMNS` read as `strtoumax` reads a count: blanks, a `+`, a
/// base-0 number and nothing after it. Zero is no limit, and so is a width
/// past any listing, a number too large for its type included. None for a
/// word that holds no such number.
fn line_width(raw: &[u8]) -> Option<Option<u64>> {
    let parts = number::parts(raw, true);
    if !parts.whole() || parts.negative() {
        return None;
    }
    let wide = parts.saturating();
    Some((wide != 0 && wide < u128::from(WIDEST)).then_some(wide as u64))
}

/// `-T`: a count as `-w` reads one, refused when it is none or too large to
/// keep.
fn tab_size(raw: &[u8]) -> Result<u64, StreamError> {
    let parts = number::parts(raw, true);
    let refused = |clause: &str| {
        StreamError::refusal(
            format!("ls: invalid tab size: '{}'{clause}", quoted(raw)).as_bytes(),
            2,
        )
    };
    if !parts.whole() || parts.negative() {
        return Err(refused(""));
    }
    parts
        .value()
        .and_then(|size| u64::try_from(size).ok())
        .ok_or_else(|| refused(&format!(": {}", number::EOVERFLOW)))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Layout {
    Vertical,
    Horizontal,
    Commas,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LayoutConfig {
    format: Layout,
    /// The line width, None for no limit.
    width: Option<u64>,
    tabsize: u64,
}

/// `-C`, `-x` and `-m` over the rows the host rendered, each one ended by
/// a NUL: the lines, each ended by a newline.
pub(crate) fn open_columns(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let LayoutConfig {
        format,
        width,
        tabsize,
    } = parse_config(config)?;
    Ok(Box::new(Columns {
        format,
        width,
        tabsize,
        held: Vec::new(),
        finished: false,
    }))
}

struct Columns {
    format: Layout,
    width: Option<u64>,
    tabsize: u64,
    held: Vec<u8>,
    finished: bool,
}

impl Stream for Columns {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.finished {
            self.held.extend_from_slice(input);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if std::mem::replace(&mut self.finished, true) {
            return Ok(());
        }
        let held = std::mem::take(&mut self.held);
        let rows: Vec<&[u8]> = held
            .split(|&b| b == 0)
            .take(held.iter().filter(|&&b| b == 0).count())
            .collect();
        let widths: Vec<u64> = rows.iter().map(|row| text_width(row)).collect();
        match self.format {
            Layout::Commas => commas(&rows, &widths, self.width, out),
            Layout::Vertical | Layout::Horizontal => grid(
                &rows,
                &widths,
                matches!(self.format, Layout::Vertical),
                self.width,
                self.tabsize,
                out,
            ),
        }
        Ok(())
    }
}

/// The columns a rendered row takes: each character its display width, a
/// character the escape style escapes, a byte that is no UTF-8 and a
/// `--hyperlink` escape none, as the C locale counts what it cannot print.
fn text_width(text: &[u8]) -> u64 {
    const LINK: &[u8] = b"\x1b]8;;";
    let mut wide = 0;
    let mut rest = text;
    while let Some(at) = rest.windows(LINK.len()).position(|w| w == LINK) {
        wide += shown_width(&rest[..at]);
        let after = &rest[at + LINK.len()..];
        rest = after
            .iter()
            .position(|&b| b == 0x07)
            .map_or(&[][..], |end| &after[end + 1..]);
    }
    wide + shown_width(rest)
}

fn shown_width(text: &[u8]) -> u64 {
    text.utf8_chunks()
        .flat_map(|chunk| chunk.valid().chars())
        .filter(|&c| !escaped(Some(c)))
        .map(|c| char_width(u32::from(c)))
        .sum()
}

/// `-m`: the rows on a line, `, ` between them, a line ending after a
/// comma where the next row and two columns more reach the width.
fn commas(rows: &[&[u8]], widths: &[u64], width: Option<u64>, out: &mut Vec<u8>) {
    let mut at = 0u64;
    for (i, (row, wide)) in rows.iter().zip(widths).enumerate() {
        if i > 0 {
            if width.is_some_and(|limit| at + wide + 2 >= limit) {
                out.extend_from_slice(b",\n");
                at = 0;
            } else {
                out.extend_from_slice(b", ");
                at += 2;
            }
        }
        out.extend_from_slice(row);
        at += wide;
    }
    if !rows.is_empty() {
        out.push(b'\n');
    }
}

/// `-C` (down each column) and `-x` (across each line): the most columns
/// whose line, two columns between them and each column at least three
/// wide, stays under the width; with no
/// width, one line, two spaces between the rows. A count
/// whose line cannot fit by a bound read from the widths alone is passed
/// over unmeasured, and so is a count down the columns that leaves one
/// empty, which lays out as the count it fills; so a wide line over many
/// rows measures only the counts near the one it takes.
fn grid(
    rows: &[&[u8]],
    widths: &[u64],
    down: bool,
    width: Option<u64>,
    tabsize: u64,
    out: &mut Vec<u8>,
) {
    let count = rows.len();
    if count == 0 {
        return;
    }
    let Some(limit) = width else {
        out.extend_from_slice(&rows.join(&b"  "[..]));
        out.push(b'\n');
        return;
    };
    let most = usize::try_from(limit / 3)
        .unwrap_or(usize::MAX)
        .clamp(1, count);
    let total: u64 = widths.iter().sum();
    let widest = widths.iter().copied().max().unwrap_or(0);
    let narrowest = widths.iter().copied().min().unwrap_or(0);
    let place = |at: usize, columns: usize, lines: usize| {
        if down { at / lines } else { at % columns }
    };
    let mut chosen = (1, count, vec![widest]);
    for columns in (2..=most).rev() {
        let lines = count.div_ceil(columns);
        if down && count.div_ceil(lines) < columns {
            continue;
        }
        let gaps = 2 * (columns as u64 - 1);
        let floor = total
            .div_ceil(lines as u64)
            .max(widest + (columns as u64 - 1) * narrowest);
        if floor + gaps >= limit {
            continue;
        }
        let mut spans = vec![NARROWEST; columns];
        for (at, wide) in widths.iter().enumerate() {
            let column = place(at, columns, lines);
            let gap = if column + 1 < columns { 2 } else { 0 };
            spans[column] = spans[column].max(wide + gap);
        }
        let line: u64 = spans.iter().sum();
        if line < limit {
            chosen = (columns, lines, spans);
            break;
        }
    }
    let (columns, lines, spans) = chosen;
    for line in 0..lines {
        let mut at = 0u64;
        let mut start = 0u64;
        let members: Vec<usize> = if down {
            (0..columns)
                .map(|column| column * lines + line)
                .filter(|&i| i < count)
                .collect()
        } else {
            (line * columns..((line + 1) * columns).min(count)).collect()
        };
        for (k, &i) in members.iter().enumerate() {
            if k > 0 {
                pad(at, start, tabsize, out);
                at = start;
            }
            out.extend_from_slice(rows[i]);
            at += widths[i];
            start += spans[place(i, columns, lines)];
        }
        out.push(b'\n');
    }
}

/// Move from column `from` to `to`: a tab wherever one does not pass `to`,
/// spaces for the rest, spaces only when `tabsize` is 0.
fn pad(mut from: u64, to: u64, tabsize: u64, out: &mut Vec<u8>) {
    while from < to {
        if tabsize != 0 && to / tabsize > (from + 1) / tabsize {
            out.push(b'\t');
            from += tabsize - from % tabsize;
        } else {
            out.push(b' ');
            from += 1;
        }
    }
}

/// `--time-style`: any `posix-` spelling is the locale style, since there
/// is no other locale; `+FORMAT` comes back whole; anything else is one
/// of the named styles, refused with exit 2.
fn style(raw: &[u8]) -> Result<String, StreamError> {
    if raw.starts_with(b"posix-") {
        return Ok("locale".to_owned());
    }
    if raw.starts_with(b"+") {
        return Ok(byte_text(raw));
    }
    word::matched(raw, TIME_STYLE)
        .map(str::to_owned)
        .map_err(|why| {
            let refused = format!(
                "{}\n{TIME_STYLES_LISTED}",
                word::line("ls", "time style", raw, why)
            );
            StreamError::refusal(refused.as_bytes(), 2)
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    fn values(typed: &[(&str, &[u8])]) -> serde_json::Value {
        scan("ls", typed).expect("read")
    }

    #[test]
    fn with_no_option_every_value_is_its_default() {
        assert_eq!(
            values(&[]),
            json!({
                "sort": null,
                "time": "mtime",
                "indicator": "none",
                "hyperlink": false,
                "block_size": null,
                "time_style": "locale",
                "format": "single-column",
                "quoting": "literal",
                "hide_control": false,
                "width": 80,
                "tabsize": 8,
                "warnings": [],
            })
        );
    }

    #[test]
    fn the_last_format_wins_but_one_per_line_leaves_long_long() {
        for (typed, format) in [
            (&[("args_l", &b""[..]), ("C", b"")][..], "vertical"),
            (&[("C", b""), ("args_l", b"")], "verbose"),
            (&[("g", b""), ("C", b"")], "vertical"),
            (&[("args_l", b""), ("args_1", b"")], "verbose"),
            (&[("args_1", b""), ("args_l", b"")], "verbose"),
            (&[("x", b""), ("args_1", b"")], "single-column"),
            (&[("full_time", b""), ("args_1", b"")], "verbose"),
            (&[("m", b""), ("numeric_uid_gid", b"")], "verbose"),
            (&[("args_l", b""), ("m", b"")], "commas"),
            (&[("format", b"across")], "horizontal"),
            (&[("format", b"long"), ("args_1", b"")], "verbose"),
            (&[("format", b"si")], "single-column"),
        ] {
            assert_eq!(values(typed)["format"], json!(format), "{typed:?}");
        }
        assert_eq!(
            values(&[("full_time", b""), ("time_style", b"iso")])["time_style"],
            json!("iso")
        );
        assert_eq!(
            values(&[("time_style", b"iso"), ("full_time", b"")])["time_style"],
            json!("full-iso")
        );
        assert_eq!(values(&[("f", b"")])["sort"], json!("none"));
        assert_eq!(values(&[("f", b""), ("t", b"")])["sort"], json!("time"));
        assert_eq!(
            values(&[("human_readable", b""), ("si", b"")])["block_size"],
            json!({"divisor": "1000", "suffix": "", "human_base": 1000})
        );
        assert_eq!(
            values(&[("si", b""), ("human_readable", b"")])["block_size"],
            json!(null)
        );
        assert_eq!(
            refusal("ls", &[("format", b"x")]),
            (
                "ls: invalid argument 'x' for '--format'\nValid arguments are:\n  \
                 - 'verbose', 'long'\n  - 'commas'\n  - 'horizontal', 'across'\n  \
                 - 'vertical'\n  - 'single-column'\nTry 'ls --help' for more information."
                    .to_owned(),
                1
            )
        );
    }

    #[test]
    fn the_last_quoting_option_wins_over_quoting_style_in_the_environment() {
        for (typed, style) in [
            (&[("escape", &b""[..]), ("literal", b"")][..], "literal"),
            (&[("literal", b""), ("escape", b"")], "escape"),
            (
                &[("quote_name", b""), ("quoting_style", b"literal")],
                "literal",
            ),
            (&[("quoting_style", b"literal"), ("quote_name", b"")], "c"),
            (&[("quoting_style", b"shell-a")], "shell-always"),
            (&[("quoting_env", b"c")], "c"),
            (&[("quoting_env", b"shell-a")], "shell-always"),
            (&[("escape", b""), ("quoting_env", b"bogus")], "escape"),
        ] {
            assert_eq!(values(typed)["quoting"], json!(style), "{typed:?}");
            assert_eq!(values(typed)["warnings"], json!([]), "{typed:?}");
        }
        for raw in [&b"sh"[..], b"", b"bogus"] {
            let read = values(&[("quoting_env", raw)]);
            assert_eq!(read["quoting"], json!("literal"));
            assert_eq!(
                read["warnings"],
                json!([format!(
                    "ls: ignoring invalid value of environment variable QUOTING_STYLE: '{}'",
                    String::from_utf8_lossy(raw)
                )])
            );
        }
        assert_eq!(
            refusal("ls", &[("quoting_style", b"sh")]).0.lines().next(),
            Some("ls: ambiguous argument 'sh' for '--quoting-style'")
        );
        let typed: &[(&str, &[u8])] = &[("hide_control_chars", b""), ("show_control_chars", b"")];
        assert_eq!(values(typed)["hide_control"], json!(false));
        let typed: &[(&str, &[u8])] = &[("show_control_chars", b""), ("hide_control_chars", b"")];
        assert_eq!(values(typed)["hide_control"], json!(true));
    }

    #[test]
    fn widths_and_tab_sizes_read_as_base_zero_counts() {
        for (raw, width) in [
            (&b"+5"[..], json!(5)),
            (b"010", json!(8)),
            (b"0x10", json!(16)),
            (b" 5", json!(5)),
            (b"0", json!(null)),
            (b"00", json!(null)),
            (b"18446744073709551616", json!(null)),
        ] {
            assert_eq!(values(&[("width", raw)])["width"], width, "{raw:?}");
        }
        for raw in [&b"5k"[..], b"-0", b"", b"-1", b"09", b"0x"] {
            assert_eq!(
                refusal("ls", &[("width", raw)]),
                (
                    format!("ls: invalid line width: '{}'", String::from_utf8_lossy(raw)),
                    2
                ),
                "{raw:?}"
            );
        }
        for (raw, size) in [
            (&b"+3"[..], 3),
            (b"010", 8),
            (b"0x3", 3),
            (b" 3", 3),
            (b"0", 0),
        ] {
            assert_eq!(
                values(&[("tabsize", raw)])["tabsize"],
                json!(size),
                "{raw:?}"
            );
        }
        for raw in [&b"3k"[..], b"-0", b""] {
            assert_eq!(refusal("ls", &[("tabsize", raw)]).1, 2, "{raw:?}");
        }
        assert_eq!(
            refusal("ls", &[("tabsize", b"99999999999999999999")]).0,
            "ls: invalid tab size: '99999999999999999999': Value too large for defined data type"
        );
        let typed: &[(&str, &[u8])] = &[("width", b"x"), ("format", b"y")];
        assert_eq!(refusal("ls", typed).1, 2);
    }

    #[test]
    fn columns_is_read_only_for_a_layout_no_width_was_typed_for() {
        let typed: &[(&str, &[u8])] = &[("C", b""), ("columns_env", b"30")];
        assert_eq!(values(typed)["width"], json!(30));
        let typed: &[(&str, &[u8])] = &[("C", b""), ("columns_env", b" +20")];
        assert_eq!(values(typed)["width"], json!(20));
        let typed: &[(&str, &[u8])] = &[("C", b""), ("columns_env", b"")];
        assert_eq!(values(typed)["warnings"], json!([]));
        for typed in [
            &[("columns_env", &b"x"[..])][..],
            &[("args_l", b""), ("columns_env", b"x")],
            &[("C", b""), ("width", b"20"), ("columns_env", b"x")],
        ] {
            assert_eq!(values(typed)["warnings"], json!([]), "{typed:?}");
        }
        let typed: &[(&str, &[u8])] = &[("m", b""), ("columns_env", b"-5")];
        let read = values(typed);
        assert_eq!(read["width"], json!(80));
        assert_eq!(
            read["warnings"],
            json!(["ls: ignoring invalid width in environment variable COLUMNS: '-5'"])
        );
    }

    fn laid_out(format: &str, width: Option<u64>, tabsize: u64, rows: &[&str]) -> String {
        let config = json!({"format": format, "width": width, "tabsize": tabsize}).to_string();
        let mut stream = crate::open("ls_columns", config.as_bytes()).expect("layout");
        let mut out = Vec::new();
        for row in rows {
            stream.feed(row.as_bytes(), &mut out).unwrap();
            stream.feed(b"\0", &mut out).unwrap();
        }
        stream.finish(&mut out).unwrap();
        String::from_utf8(out).expect("utf-8")
    }

    // Each layout pinned on debian:stable-slim (coreutils 9.7).
    #[test]
    fn columns_fill_down_or_across_under_the_width_with_tabs_where_they_fit() {
        let names = [
            "alpha", "beta", "delta", "dir", "epsilon", "eta", "gamma", "iota", "kappa", "lambda",
            "mu", "nu", "omicron", "pi", "rho", "sigma", "tau", "theta", "upsilon", "xi", "zeta",
        ];
        assert_eq!(
            laid_out("vertical", Some(80), 8, &names),
            "alpha  delta  epsilon  gamma  kappa   mu  omicron  rho\t  tau\t upsilon  zeta\n\
             beta   dir    eta      iota   lambda  nu  pi\t   sigma  theta  xi\n"
        );
        assert_eq!(
            laid_out("vertical", Some(40), 8, &names),
            "alpha\t eta\t mu\t  sigma    zeta\nbeta\t gamma\t nu\t  tau\n\
             delta\t iota\t omicron  theta\ndir\t kappa\t pi\t  upsilon\n\
             epsilon  lambda  rho\t  xi\n"
        );
        assert_eq!(
            laid_out("vertical", Some(40), 0, &names),
            "alpha    eta     mu       sigma    zeta\nbeta     gamma   nu       tau\n\
             delta    iota    omicron  theta\ndir      kappa   pi       upsilon\n\
             epsilon  lambda  rho      xi\n"
        );
        assert_eq!(
            laid_out("horizontal", Some(40), 8, &names),
            "alpha  beta   delta    dir\tepsilon\neta    gamma  iota     kappa\tlambda\n\
             mu     nu     omicron  pi\trho\nsigma  tau    theta    upsilon\txi\nzeta\n"
        );
        assert_eq!(
            laid_out("commas", Some(40), 8, &names),
            "alpha, beta, delta, dir, epsilon, eta,\ngamma, iota, kappa, lambda, mu, nu,\n\
             omicron, pi, rho, sigma, tau, theta,\nupsilon, xi, zeta\n"
        );
        assert_eq!(
            laid_out("vertical", None, 8, &names),
            names.join("  ") + "\n"
        );
        let linked = ["\x1b]8;;file:///d/a\x07a\x1b]8;;\x07", "bb", "c"];
        assert_eq!(
            laid_out("vertical", Some(11), 8, &linked),
            "\x1b]8;;file:///d/a\x07a\x1b]8;;\x07  bb  c\n"
        );
        assert_eq!(laid_out("vertical", Some(8), 0, &["cxc", "y"]), "cxc\ny\n");
        assert_eq!(laid_out("vertical", Some(9), 0, &["cxc", "y"]), "cxc  y\n");
        let unprinted = ["c\x01c", "d\td", "e\u{85}e", "y"];
        assert_eq!(
            laid_out("vertical", Some(15), 0, &unprinted),
            "c\x01c  e\u{85}e\nd\td  y\n"
        );
        assert_eq!(
            laid_out("vertical", Some(16), 0, &unprinted),
            "c\x01c  d\td  e\u{85}e  y\n"
        );
        let short = ["a", "back~", "big", "cx", "d"];
        assert_eq!(
            laid_out("vertical", Some(30), 3, &short),
            "a\tback~  big\tcx  d\n"
        );
        assert_eq!(laid_out("vertical", Some(80), 8, &[]), "");
        assert_eq!(laid_out("commas", Some(80), 8, &[]), "");
    }

    #[test]
    fn a_line_fits_only_under_the_width_and_commas_count_the_one_to_follow() {
        let four = ["aaaa", "bbbb", "cccc", "dddd"];
        assert_eq!(
            laid_out("vertical", Some(22), 8, &four),
            "aaaa  cccc\nbbbb  dddd\n"
        );
        assert_eq!(
            laid_out("vertical", Some(23), 8, &four),
            "aaaa  bbbb  cccc  dddd\n"
        );
        assert_eq!(
            laid_out("horizontal", Some(22), 8, &four),
            "aaaa  bbbb  cccc\ndddd\n"
        );
        for (width, out) in [
            (10, "aaaa,\nbbbb,\ncccc,\ndddd\n"),
            (11, "aaaa, bbbb,\ncccc, dddd\n"),
            (16, "aaaa, bbbb,\ncccc, dddd\n"),
            (17, "aaaa, bbbb, cccc,\ndddd\n"),
            (22, "aaaa, bbbb, cccc,\ndddd\n"),
            (23, "aaaa, bbbb, cccc, dddd\n"),
        ] {
            assert_eq!(laid_out("commas", Some(width), 8, &four), out, "{width}");
        }
    }

    #[test]
    fn a_wide_line_over_many_rows_measures_only_the_counts_near_its_own() {
        let rows: Vec<String> = (0..20_000).map(|i| format!("name{i:05}")).collect();
        let rows: Vec<&str> = rows.iter().map(String::as_str).collect();
        let started = std::time::Instant::now();
        let out = laid_out("vertical", Some(150_000), 8, &rows);
        assert_eq!(out.lines().count(), 2);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn the_last_spelling_of_each_setting_wins() {
        let typed: &[(&str, &[u8])] = &[("sort", b"non"), ("t", b"")];
        assert_eq!(values(typed)["sort"], json!("time"));
        let typed: &[(&str, &[u8])] = &[("S", b""), ("sort", b"ver")];
        assert_eq!(values(typed)["sort"], json!("version"));
        let typed: &[(&str, &[u8])] = &[("time", b"a"), ("c", b"")];
        assert_eq!(values(typed)["time"], json!("ctime"));
        let typed: &[(&str, &[u8])] = &[("u", b""), ("time", b"birth")];
        assert_eq!(values(typed)["time"], json!("birth"));
        let typed: &[(&str, &[u8])] = &[("classify", b"always"), ("p", b"")];
        assert_eq!(values(typed)["indicator"], json!("slash"));
        let typed: &[(&str, &[u8])] = &[("file_type", b""), ("classify", b"never")];
        assert_eq!(values(typed)["indicator"], json!("none"));
        let typed: &[(&str, &[u8])] = &[("p", b""), ("indicator_style", b"c")];
        assert_eq!(values(typed)["indicator"], json!("classify"));
        let typed: &[(&str, &[u8])] = &[("hyperlink", b"always"), ("hyperlink", b"auto")];
        assert_eq!(values(typed)["hyperlink"], json!(false));
        let typed: &[(&str, &[u8])] = &[("hyperlink", b"yes")];
        assert_eq!(values(typed)["hyperlink"], json!(true));
    }

    #[test]
    fn the_later_of_h_and_block_size_wins() {
        let typed: &[(&str, &[u8])] = &[("block_size", b"K"), ("human_readable", b"")];
        assert_eq!(values(typed)["block_size"], json!(null));
        let typed: &[(&str, &[u8])] = &[("human_readable", b""), ("block_size", b"K")];
        assert_eq!(
            values(typed)["block_size"],
            json!({"divisor": "1024", "suffix": "K", "human_base": null})
        );
        let typed: &[(&str, &[u8])] = &[("block_size", b"x"), ("human_readable", b"")];
        assert_eq!(refusal("ls", typed).1, 2);
    }

    #[test]
    fn a_block_size_is_a_count_then_a_unit() {
        for (raw, divisor, suffix, base) in [
            ("human-readable", "1024", "", json!(1024)),
            ("si", "1000", "", json!(1000)),
            ("4", "4", "", json!(null)),
            (" +1", "1", "", json!(null)),
            ("k", "1024", "K", json!(null)),
            ("K", "1024", "K", json!(null)),
            ("KB", "1000", "kB", json!(null)),
            ("KiB", "1024", "KiB", json!(null)),
            ("MB", "1000000", "MB", json!(null)),
            ("2K", "2048", "", json!(null)),
            ("010", "10", "", json!(null)),
            ("15E", "17293822569102704640", "", json!(null)),
            (
                "18446744073709551615",
                "18446744073709551615",
                "",
                json!(null),
            ),
        ] {
            assert_eq!(
                values(&[("block_size", raw.as_bytes())])["block_size"],
                json!({"divisor": divisor, "suffix": suffix, "human_base": base}),
                "{raw}"
            );
        }
    }

    #[test]
    fn a_block_size_refusal_quotes_the_word_unescaped_and_exits_two() {
        let shown = |raw: &str, how: &str| match how {
            "suffix" => format!("ls: invalid suffix in --block-size argument '{raw}'"),
            "large" => format!("ls: --block-size argument '{raw}' too large"),
            _ => format!("ls: invalid --block-size argument '{raw}'"),
        };
        for (raw, how) in [
            ("x", "invalid"),
            ("0", "invalid"),
            ("0K", "invalid"),
            ("iB", "invalid"),
            ("B", "invalid"),
            ("-1K", "invalid"),
            ("", "invalid"),
            ("+K", "invalid"),
            (" K", "invalid"),
            ("+ 1", "invalid"),
            ("bogus", "invalid"),
            ("1x", "suffix"),
            ("1e", "suffix"),
            ("Kx", "suffix"),
            ("1Ki", "suffix"),
            ("1.5K", "suffix"),
            ("1R", "suffix"),
            ("1 ", "suffix"),
            ("1p", "suffix"),
            ("Y", "large"),
            ("16E", "large"),
            ("18446744073709551616", "large"),
            (&"9".repeat(50), "large"),
        ] {
            assert_eq!(
                refusal("ls", &[("block_size", raw.as_bytes())]),
                (shown(raw, how), 2),
                "{raw:?}"
            );
        }
        assert_eq!(
            refusal("ls", &[("block_size", "1\u{e9}".as_bytes())]).0,
            "ls: invalid suffix in --block-size argument '1\u{e9}'"
        );
    }

    #[test]
    fn each_word_is_checked_where_it_was_typed() {
        let typed: &[(&str, &[u8])] = &[("sort", b"bogus"), ("sort", b"size")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: invalid argument 'bogus' for '--sort'")
        );
        let typed: &[(&str, &[u8])] = &[("time", b"x"), ("sort", b"y")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: invalid argument 'x' for '--time'")
        );
        let typed: &[(&str, &[u8])] = &[("time_style", b"x"), ("block_size", b"y")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: invalid --block-size")
        );
        let typed: &[(&str, &[u8])] = &[("color", b"x")];
        assert_eq!(refusal("ls", typed).1, 1);
        let typed: &[(&str, &[u8])] = &[("classify", b""), ("p", b"")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: ambiguous argument '' for '--classify'")
        );
    }

    #[test]
    fn a_word_refusal_lists_the_choices_and_exits_one() {
        assert_eq!(
            refusal("ls", &[("sort", b"n")]),
            (
                "ls: ambiguous argument 'n' for '--sort'\nValid arguments are:\n  - 'none'\n  \
                 - 'size'\n  - 'time'\n  - 'version'\n  - 'extension'\n  - 'name'\n  \
                 - 'width'\nTry 'ls --help' for more information."
                    .to_owned(),
                1
            )
        );
        assert_eq!(
            refusal("ls", &[("hyperlink", b"a")]).0,
            "ls: ambiguous argument 'a' for '--hyperlink'\nValid arguments are:\n  \
             - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  \
             - 'auto', 'tty', 'if-tty'\nTry 'ls --help' for more information."
        );
    }

    #[test]
    fn the_time_style_is_its_last_value_read_after_the_loop() {
        for (raw, style) in [
            ("full", "full-iso"),
            ("long-iso", "long-iso"),
            ("iso", "iso"),
            ("posix-zzz", "locale"),
            ("posix-", "locale"),
            ("+%Y/%m", "+%Y/%m"),
            ("+%Y\n%H", "+%Y\n%H"),
        ] {
            assert_eq!(
                values(&[("time_style", raw.as_bytes())])["time_style"],
                json!(style),
                "{raw:?}"
            );
        }
        let typed: &[(&str, &[u8])] = &[("time_style", b"x"), ("time_style", b"iso")];
        assert_eq!(values(typed)["time_style"], json!("iso"));
        let listed = "Valid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  \
                      - [posix-]iso\n  - [posix-]locale\n  \
                      - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n\
                      Try 'ls --help' for more information.";
        assert_eq!(
            refusal("ls", &[("time_style", b"")]),
            (
                format!("ls: ambiguous argument '' for 'time style'\n{listed}"),
                2
            )
        );
        assert_eq!(
            refusal("ls", &[("time_style", b"x\x01")]).0,
            format!("ls: invalid argument 'x\\001' for 'time style'\n{listed}")
        );
        let typed: &[(&str, &[u8])] = &[("time_style", b"x"), ("sort", b"y")];
        assert!(refusal("ls", typed).0.contains("for '--sort'"));
    }
}
