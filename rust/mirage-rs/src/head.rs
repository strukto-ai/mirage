//! head's typed counts: `-n` a whole signed decimal, `-c` the same with a
//! size letter after it, refused in head's words. Only the last of each is
//! checked, lines before bytes, where GNU checks each one as it is typed:
//! a divergence both hosts had, kept until it is pinned.

use serde_json::Value as Json;

use crate::number;
use crate::scan::{Typed, Values, last, unknown};
use crate::{StreamError, quoted};

/// The size letters head and tail take after a byte count.
const BYTE_LETTERS: &[u8] = b"bkKMGTPEZYRQ";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    if let Some((name, _)) = options
        .iter()
        .find(|(name, _)| name != "lines" && name != "bytes")
    {
        return Err(unknown("head", name));
    }
    let lines = last(options, "lines")
        .map(|raw| lines("head", raw))
        .transpose()?;
    let bytes = last(options, "bytes")
        .map(|raw| bytes("head", raw))
        .transpose()?;
    let mut values = Values::new();
    values.insert("lines".to_owned(), lines.map_or(Json::Null, Json::from));
    values.insert("bytes".to_owned(), bytes.map_or(Json::Null, Json::from));
    Ok(values)
}

/// A line count: a sign, then decimal digits and nothing else, a magnitude
/// past `i64` saturating.
pub(crate) fn lines(command: &str, raw: &[u8]) -> Result<i64, StreamError> {
    signed(raw, b"").ok_or_else(|| refused(command, "lines", raw))
}

/// A byte count: a sign, decimal digits, then a size letter from head's
/// set, the product saturating past `i64`.
pub(crate) fn bytes(command: &str, raw: &[u8]) -> Result<i64, StreamError> {
    signed(raw, BYTE_LETTERS).ok_or_else(|| refused(command, "bytes", raw))
}

/// `raw` as `[+-]?[0-9]+` and a suffix `number::unit` reads from
/// `letters`, with no blank before it.
fn signed(raw: &[u8], letters: &[u8]) -> Option<i64> {
    let unsigned = raw.strip_prefix(b"+").or_else(|| raw.strip_prefix(b"-"));
    let body = unsigned.unwrap_or(raw);
    let digits = body.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let multiplier = match &body[digits..] {
        [] => 1,
        suffix => number::unit(suffix, letters)?,
    };
    let parts = number::parts(&body[..digits], false);
    let magnitude = parts.saturating().saturating_mul(multiplier);
    let magnitude = i64::try_from(magnitude).unwrap_or(i64::MAX);
    Some(if raw.first() == Some(&b'-') {
        -magnitude
    } else {
        magnitude
    })
}

fn refused(command: &str, unit: &str, raw: &[u8]) -> StreamError {
    let shown = format!("{command}: invalid number of {unit}: '{}'", quoted(raw));
    StreamError::refusal(shown.as_bytes(), 1)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    #[test]
    fn counts_take_a_sign_and_bytes_a_size_letter() {
        let values = scan("head", &[("lines", b"-3"), ("bytes", b"+2K")]).expect("read");
        assert_eq!(values, json!({"lines": -3, "bytes": 2048}));
        for (raw, value) in [
            ("1kB", 1000),
            ("1KiB", 1024),
            ("2b", 1024),
            ("1E", 1i64 << 60),
        ] {
            let values = scan("head", &[("bytes", raw.as_bytes())]).expect(raw);
            assert_eq!(values["bytes"], json!(value), "{raw}");
        }
    }

    #[test]
    fn a_count_past_i64_saturates() {
        let values = scan("head", &[("lines", &[b'9'; 5000]), ("bytes", b"-1Q")]).expect("read");
        assert_eq!(values, json!({"lines": i64::MAX, "bytes": -i64::MAX}));
    }

    #[test]
    fn lines_take_no_suffix_blank_or_newline() {
        for raw in [
            "2K", " 2", "2\n", "2 ", "", "+", "--3", "0x10", "1.5", "\u{e9}",
        ] {
            let shown = format!(
                "head: invalid number of lines: '{}'",
                crate::quoted(raw.as_bytes())
            );
            assert_eq!(
                refusal("head", &[("lines", raw.as_bytes())]),
                (shown, 1),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn bytes_refuse_a_letter_outside_the_set() {
        for raw in ["1m", "1bB", "1Ki", "K", "1kb", "1 "] {
            let shown = format!("head: invalid number of bytes: '{raw}'");
            assert_eq!(
                refusal("head", &[("bytes", raw.as_bytes())]),
                (shown, 1),
                "{raw}"
            );
        }
    }

    #[test]
    fn only_the_last_of_each_is_read_lines_first() {
        let typed: &[(&str, &[u8])] = &[("lines", b"x"), ("lines", b"2")];
        assert_eq!(scan("head", typed).expect("read")["lines"], json!(2));
        let typed: &[(&str, &[u8])] = &[("bytes", b"y"), ("lines", b"x")];
        assert_eq!(
            refusal("head", typed).0,
            "head: invalid number of lines: 'x'"
        );
    }
}
