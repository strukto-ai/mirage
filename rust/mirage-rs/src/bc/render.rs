use std::ops::ControlFlow;

use num_bigint::BigInt;
use num_traits::{One, Signed, ToPrimitive, Zero};

use super::common::{Budget, NumericError, OutputBase};
use super::numbers::{Number, power_ten};

const BASE_DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

fn c_atoi(text: &str) -> i32 {
    let mut bytes = text
        .trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c'])
        .bytes()
        .peekable();
    let negative = bytes.peek() == Some(&b'-');
    if matches!(bytes.peek(), Some(b'+' | b'-')) {
        bytes.next();
    }
    let limit = if negative {
        1u64 << 63
    } else {
        i64::MAX as u64
    };
    let mut value = 0u64;
    for digit in bytes {
        if !digit.is_ascii_digit() {
            break;
        }
        value = value
            .saturating_mul(10)
            .saturating_add(u64::from(digit - b'0'))
            .min(limit);
    }
    if negative {
        value.wrapping_neg() as i32
    } else {
        value as i32
    }
}

pub(super) struct Output {
    line_length: usize,
    column: usize,
}

pub(super) struct OutputCursor {
    text: String,
    offset: usize,
}

impl OutputCursor {
    pub(super) fn new(text: String) -> Self {
        Self { text, offset: 0 }
    }
}

impl Output {
    pub(super) fn new(raw: Option<&str>) -> Self {
        let requested = raw.map(c_atoi).unwrap_or(70);
        let line_length = if requested != 0 && requested < 3 {
            70
        } else {
            requested as usize
        };
        Self {
            line_length,
            column: 0,
        }
    }

    pub(super) fn advance(
        &mut self,
        cursor: &mut OutputCursor,
        budget: &mut Budget,
        out: &mut Vec<u8>,
    ) -> ControlFlow<()> {
        while cursor.offset < cursor.text.len() {
            if !budget.take() {
                return ControlFlow::Continue(());
            }
            let char = cursor.text[cursor.offset..]
                .chars()
                .next()
                .expect("cursor starts on UTF-8 boundary");
            let width = char.len_utf8();
            if char == '\n' {
                self.column = 0;
            } else {
                if self.line_length != 0
                    && self.column != 0
                    && self.column + width > self.line_length - 2
                {
                    out.extend_from_slice(b"\\\n");
                    self.column = 0;
                }
                self.column += width;
            }
            out.extend_from_slice(&cursor.text.as_bytes()[cursor.offset..cursor.offset + width]);
            cursor.offset += width;
        }
        ControlFlow::Break(())
    }
}

fn fixed_digits(number: &Number) -> String {
    let digits = number.coefficient.abs().to_str_radix(10);
    let required = number.scale as usize + 1;
    let mut result = String::with_capacity(digits.len().max(required) + 2);
    if number.coefficient.is_negative() {
        result.push('-');
    }
    if digits.len() < required {
        result.extend(std::iter::repeat_n('0', required - digits.len()));
    }
    result.push_str(&digits);
    if number.scale != 0 {
        result.insert(result.len() - number.scale as usize, '.');
    }
    result
}

fn render_in_base(number: &Number, base: u32) -> Result<String, NumericError> {
    let denominator = power_ten(number.scale)?;
    let magnitude = number.coefficient.abs();
    let mut whole = &magnitude / &denominator;
    let mut rest = &magnitude % &denominator;
    let mut before = Vec::new();
    while !whole.is_zero() {
        before.push((&whole % base).to_u32().expect("radix digit fits u32"));
        whole /= base;
    }
    before.reverse();
    let mut after = Vec::new();
    let mut factor = BigInt::one();
    while factor < denominator {
        rest *= base;
        after.push(
            (&rest / &denominator)
                .to_u32()
                .expect("radix digit fits u32"),
        );
        rest %= &denominator;
        factor *= base;
    }
    let mut text = String::new();
    if base <= 16 {
        for digit in before {
            text.push(char::from(BASE_DIGITS[digit as usize]));
        }
        if !after.is_empty() {
            text.push('.');
            for digit in after {
                text.push(char::from(BASE_DIGITS[digit as usize]));
            }
        }
    } else {
        use std::fmt::Write;
        let width = (base - 1).to_string().len();
        for digit in before {
            write!(text, " {digit:0width$}").expect("write into String");
        }
        if !after.is_empty() {
            text.push('.');
            for (index, digit) in after.into_iter().enumerate() {
                if index != 0 {
                    text.push(' ');
                }
                write!(text, "{digit:0width$}").expect("write into String");
            }
        }
    }
    if text.is_empty() {
        text.push('0');
    }
    Ok(text)
}

pub(super) fn render_number(number: &Number, base: OutputBase) -> Result<String, NumericError> {
    if number.is_zero() {
        return Ok("0".into());
    }
    let mut text = if base.get() == 10 {
        fixed_digits(number)
    } else {
        let mut text = render_in_base(number, base.get())?;
        if number.coefficient.is_negative() {
            text.insert(0, '-');
        }
        text
    };
    if text.starts_with("0.") {
        text.remove(0);
    } else if text.starts_with("-0.") {
        text.remove(1);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_length_uses_saturating_c_long_then_wrapping_c_int() {
        for (text, expected) in [
            ("", 0),
            ("abc", 0),
            ("0x46", 0),
            ("  +12tail", 12),
            ("-12", -12),
            ("4294967296", 0),
            ("9223372036854775808", -1),
            ("-9223372036854775809", 0),
            ("999999999999999999999999999999999999999999", -1),
        ] {
            assert_eq!(c_atoi(text), expected, "{text}");
        }
    }

    fn write(output: &mut Output, text: &str, actions: u32) -> String {
        let mut cursor = OutputCursor::new(text.into());
        let mut out = Vec::new();
        while output
            .advance(&mut cursor, &mut Budget::new(actions), &mut out)
            .is_continue()
        {}
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn folding_resumes_across_calls_and_preserves_utf8_characters() {
        let mut output = Output::new(Some("5"));
        assert_eq!(write(&mut output, "ab", 1), "ab");
        assert_eq!(
            write(&mut output, "cd\né中f\n", 1),
            "c\\\nd\né\\\n中\\\nf\n"
        );
        assert_eq!(write(&mut output, "1234", 2), "123\\\n4");
        assert_eq!(
            write(&mut Output::new(Some("0")), "abcdefghij", 1),
            "abcdefghij"
        );
        assert_eq!(write(&mut Output::new(Some("3")), "中x", 1), "中\\\nx");
    }

    #[test]
    fn zero_budget_leaves_cursor_pending_without_output() {
        let mut cursor = OutputCursor::new("42".into());
        let mut output = Output::new(None);
        let mut out = Vec::new();
        assert!(
            output
                .advance(&mut cursor, &mut Budget::new(0), &mut out)
                .is_continue()
        );
        assert!(out.is_empty());
        assert_eq!(cursor.offset, 0);
        assert!(
            output
                .advance(&mut cursor, &mut Budget::new(2), &mut out)
                .is_break()
        );
        assert_eq!(out, b"42");
    }
}
