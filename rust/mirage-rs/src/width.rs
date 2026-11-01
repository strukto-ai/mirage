use serde::Deserialize;

use crate::generated::unicode_width::{SPACE, WIDE, ZERO};
use crate::{Stream, StreamError, parse_config};

pub(crate) const TAB_WIDTH: u64 = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    text: Vec<u32>,
}

/// Sum the widths of character values supplied by a host. Lone surrogates
/// remain one column, as the hosts' raw filename bytes did before encoding.
pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { text } = parse_config(config)?;
    Ok(Box::new(Width(Some(
        text.into_iter().map(char_width).sum(),
    ))))
}

struct Width(Option<u64>);

impl Stream for Width {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !input.is_empty() {
            return Err(StreamError::new(
                "width reads character values from its config",
            ));
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(width) = self.0.take() {
            out.extend_from_slice(width.to_string().as_bytes());
        }
        Ok(())
    }
}

fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// The columns a character takes, as GNU `wc -L` 9.7 counts them in
/// C.UTF-8: one that does not print takes none, and so does a form past
/// U+10FFFF, which decodes but cannot print.
pub(crate) fn char_width(cp: u32) -> u64 {
    if cp < 0x80 {
        return u64::from((0x20..0x7F).contains(&cp));
    }
    if cp > 0x10_FFFF || in_ranges(cp, ZERO) {
        0
    } else if in_ranges(cp, WIDE) {
        2
    } else {
        1
    }
}

/// A character that separates words, as GNU `wc` 9.7 splits them in C.UTF-8.
pub(crate) fn is_space(cp: u32) -> bool {
    if cp < 0x80 {
        cp == 0x20 || (0x09..=0x0D).contains(&cp)
    } else {
        in_ranges(cp, SPACE)
    }
}

/// The column after `cp`: a tab jumps to the next stop, carriage return and
/// form feed rewind to 0. The newline is the caller's.
pub(crate) fn advance_column(column: u64, cp: u32) -> u64 {
    match cp {
        0x0D | 0x0C => 0,
        0x09 => column + TAB_WIDTH - column % TAB_WIDTH,
        _ => column + char_width(cp),
    }
}

#[cfg(test)]
mod tests {
    use super::char_width;
    use crate::open;

    #[test]
    fn widths_follow_the_pinned_unicode_table() {
        for (cp, width) in [
            (0x61, 1),
            (0x4e2d, 2),
            (0x6587, 2),
            (0x1f600, 2),
            (0x301, 0),
            (0x1160, 0),
            (0x11a8, 0),
            (0x200b, 0),
            (0xfeff, 0),
            (0x61c, 0),
            (0x00, 0),
            (0x08, 0),
            (0x1b, 0),
            (0x0b, 0),
            (0xad, 1),
            (0x600, 1),
            (0x110bd, 1),
            (0x3164, 0),
            (0xffa0, 0),
            (0x3248, 2),
            (0xd7b0, 0),
            (0x378, 0),
            (0x2065, 0),
            (0x1fae9, 2),
            (0xdcff, 1),
            (0xd800, 1),
            (0x110000, 0),
        ] {
            assert_eq!(char_width(cp), width, "U+{cp:04X}");
        }
    }

    #[test]
    fn host_width_sums_characters_without_cursor_movement() {
        let mut stream = open("width", br#"{"text":[97,9,10,20013,128512,769,56575]}"#).unwrap();
        let mut out = Vec::new();
        stream.finish(&mut out).unwrap();
        stream.finish(&mut out).unwrap();
        assert_eq!(out, b"6");
        assert!(open("width", br#"{"text":[],"unknown":true}"#).is_err());
        assert!(open("width", br#"{"text":[-1]}"#).is_err());
    }
}
