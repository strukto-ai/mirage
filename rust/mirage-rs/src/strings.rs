use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// `-n` as typed.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    min_len: Option<Vec<u8>>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { min_len } = parse_config(config)?;
    let min_len = match min_len {
        Some(text) => min_length(&text).map_err(StreamError::new)?,
        None => 4,
    };
    Ok(Box::new(Strings {
        min_len,
        run: Vec::new(),
        printing: false,
    }))
}

/// `-n` as binutils 2.44 reads it, C's strtoul at base 0 over every byte,
/// refused in its words in the order it tests them.
fn min_length(text: &[u8]) -> Result<u64, String> {
    let shown = String::from_utf8_lossy(text);
    let start = text
        .iter()
        .position(|&b| !matches!(b, b' ' | b'\t'..=b'\r'))
        .unwrap_or(text.len());
    let (negative, digits) = match &text[start..] {
        [sign @ (b'+' | b'-'), rest @ ..] => (*sign == b'-', rest),
        rest => (false, rest),
    };
    let (radix, digits) = match digits {
        [b'0', b'x' | b'X', next, ..] if next.is_ascii_hexdigit() => (16, &digits[2..]),
        [b'0', ..] => (8, digits),
        _ => (10, digits),
    };
    let len = digits
        .iter()
        .position(|&b| !char::from(b).is_digit(radix))
        .unwrap_or(digits.len());
    if (len == 0 && !text.is_empty()) || len < digits.len() {
        return Err(format!("strings: invalid integer argument {shown}"));
    }
    let value = digits[..len].iter().try_fold(0u64, |value, &b| {
        let digit = u64::from(char::from(b).to_digit(radix).unwrap_or(0));
        value.checked_mul(u64::from(radix))?.checked_add(digit)
    });
    let value = match value {
        Some(value) if negative => value.wrapping_neg(),
        Some(value) => value,
        None => u64::MAX,
    };
    match value {
        0 => Err(format!(
            "strings: minimum string length is too small: {shown}"
        )),
        v if v > u64::from(u32::MAX) => Err(format!(
            "strings: minimum string length is too big: {shown}"
        )),
        v if v == u64::from(u32::MAX) => {
            Err(format!("strings: minimum string length {shown} is too big"))
        }
        v => Ok(v),
    }
}

/// binutils 2.44 strings over a whole input: every run of at least
/// `min_len` printable bytes (ASCII's graphic ones, the space and the tab)
/// is written with a newline after it.
struct Strings {
    min_len: u64,
    /// The run so far while it is shorter than `min_len`, which binutils
    /// allocates up front.
    run: Vec<u8>,
    /// The run in progress is long enough and written as it comes.
    printing: bool,
}

fn printable(byte: u8) -> bool {
    matches!(byte, b'\t' | b' '..=b'~')
}

impl Strings {
    fn end_run(&mut self, out: &mut Vec<u8>) {
        if std::mem::take(&mut self.printing) {
            out.push(b'\n');
        }
        self.run.clear();
    }
}

impl Stream for Strings {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while !rest.is_empty() {
            let len = rest
                .iter()
                .position(|&b| !printable(b))
                .unwrap_or(rest.len());
            let (text, after) = rest.split_at(len);
            if self.printing {
                out.extend_from_slice(text);
            } else if (self.run.len() + len) as u64 >= self.min_len {
                out.append(&mut self.run);
                out.extend_from_slice(text);
                self.printing = true;
            } else {
                self.run.extend_from_slice(text);
            }
            let Some((_, tail)) = after.split_first() else {
                break;
            };
            self.end_run(out);
            rest = tail;
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.end_run(out);
        Ok(())
    }
}
