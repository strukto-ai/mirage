use serde::Deserialize;

use crate::{Stream, StreamError, number, parse_config};

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
/// refused in its words in the order it tests them; a refusal names the
/// value one character per byte, which the host writes back as bytes.
fn min_length(text: &[u8]) -> Result<u64, String> {
    let shown = crate::byte_text(text);
    let parts = number::parts(text, true);
    if (parts.digits.is_empty() && !text.is_empty()) || !parts.rest.is_empty() {
        return Err(format!("strings: invalid integer argument {shown}"));
    }
    let value = match parts.value().and_then(|value| u64::try_from(value).ok()) {
        Some(value) if parts.negative() => value.wrapping_neg(),
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

#[cfg(test)]
mod tests {
    use super::min_length;

    #[test]
    fn an_overflow_stays_too_big_whatever_its_sign() {
        for raw in ["18446744073709551616", "-18446744073709551616"] {
            assert_eq!(
                min_length(raw.as_bytes()),
                Err(format!("strings: minimum string length is too big: {raw}"))
            );
        }
        assert_eq!(min_length(b"-18446744073709551615"), Ok(1));
    }
}
