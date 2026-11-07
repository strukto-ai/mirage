//! Brace expansion over a word's template: its literal text, with each
//! expansion in it as an inert atom that brings no brace syntax, as bash
//! expands braces before parameters (`{a,$v}` alternates on the atom and
//! `{1..$n}` stays literal).

/// One element of a template: a byte as typed, or an expansion's atom.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tok {
    Byte(u8),
    Atom(usize),
    /// What quote removal leaves of a lone backslash a character range
    /// yields (`{Z..b}`): nothing, in a word that is kept though empty.
    Nothing,
}

/// A template's words would hold more than the bytes left to build them,
/// or its groups nest deeper than `NESTING`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exhausted;

/// The deepest a group may sit inside another's alternatives: each level
/// expands on the stack, which a word nesting thousands deep would
/// overflow.
const NESTING: usize = 256;

/// The words a template expands to, None when nothing in it expands. Their
/// bytes, one more each, come out of `room`, the bytes left to build them
/// in (None for no bound), before they are built.
pub fn expand_template(
    template: &[Tok],
    room: &mut Option<usize>,
) -> Result<Option<Vec<Vec<Tok>>>, Exhausted> {
    let words = expand(template, room, 0)?;
    if words.len() == 1 && words[0] == template {
        return Ok(None);
    }
    Ok(Some(words))
}

/// Take `bytes` out of `room`, refusing once they do not fit.
pub fn spend(room: &mut Option<usize>, bytes: usize) -> Result<(), Exhausted> {
    if let Some(left) = room {
        *left = left.checked_sub(bytes).ok_or(Exhausted)?;
    }
    Ok(())
}

fn is(tok: Tok, byte: u8) -> bool {
    tok == Tok::Byte(byte)
}

/// The words `template` expands to, group by group from the left, each
/// word charged to `room` before it is built: a word holding thousands of
/// groups builds no deeper than its groups nest, and stops at the first
/// that does not fit.
fn expand(
    template: &[Tok],
    room: &mut Option<usize>,
    depth: usize,
) -> Result<Vec<Vec<Tok>>, Exhausted> {
    if depth > NESTING {
        return Err(Exhausted);
    }
    let mut words: Vec<Vec<Tok>> = vec![Vec::new()];
    let mut literal = 0;
    let mut i = 0;
    while i < template.len() {
        if is(template[i], b'\\') {
            i += 2;
            continue;
        }
        if !is(template[i], b'{') {
            i += 1;
            continue;
        }
        let Some(close) = match_close(template, i) else {
            i += 1;
            continue;
        };
        let body = &template[i + 1..close];
        let alternatives = match sequence(body, room)? {
            Some(words) => words,
            None => match split_alternatives(body) {
                Some(alternatives) => {
                    let mut expanded = Vec::new();
                    for alternative in &alternatives {
                        expanded.extend(expand(alternative, room, depth + 1)?);
                    }
                    expanded
                }
                None => {
                    i += 1;
                    continue;
                }
            },
        };
        let text = &template[literal..i];
        let mut next = Vec::new();
        for word in &words {
            for alternative in &alternatives {
                spend(room, word.len() + text.len() + alternative.len() + 1)?;
                next.push([word.as_slice(), text, alternative].concat());
            }
        }
        words = next;
        i = close + 1;
        literal = i;
    }
    if literal == 0 {
        return Ok(vec![template.to_vec()]);
    }
    let tail = &template[literal..];
    spend(room, tail.len() * words.len())?;
    for word in &mut words {
        word.extend_from_slice(tail);
    }
    Ok(words)
}

fn match_close(template: &[Tok], open: usize) -> Option<usize> {
    let mut depth = 1;
    let mut i = open + 1;
    while i < template.len() {
        match template[i] {
            Tok::Byte(b'\\') => {
                i += 2;
                continue;
            }
            Tok::Byte(b'{') => depth += 1,
            Tok::Byte(b'}') => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_alternatives(body: &[Tok]) -> Option<Vec<Vec<Tok>>> {
    let mut alternatives = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    let mut i = 0;
    while i < body.len() {
        match body[i] {
            Tok::Byte(b'\\') => {
                i += 2;
                continue;
            }
            Tok::Byte(b'{') => depth += 1,
            Tok::Byte(b'}') => depth -= 1,
            Tok::Byte(b',') if depth == 0 => {
                alternatives.push(body[start..i].to_vec());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if alternatives.is_empty() {
        return None;
    }
    alternatives.push(body[start..].to_vec());
    Some(alternatives)
}

/// A `{x..y[..step]}` body's words, None for one that is no sequence: it
/// must be literal throughout. Numeric endpoints with leading zeros pad
/// every word to the wider endpoint, a minus sign counting (`{-05..5..5}`
/// is `-05 000 005`); the step's direction follows the endpoints, its own
/// sign ignored and 0 read as 1. The words' bytes come out of `room`
/// before any is made.
fn sequence(body: &[Tok], room: &mut Option<usize>) -> Result<Option<Vec<Vec<Tok>>>, Exhausted> {
    let Some(text) = body
        .iter()
        .map(|tok| match tok {
            Tok::Byte(b) => Some(*b),
            Tok::Atom(_) | Tok::Nothing => None,
        })
        .collect::<Option<Vec<u8>>>()
    else {
        return Ok(None);
    };
    if text.contains(&b'\\') {
        return Ok(None);
    }
    let parts: Vec<&[u8]> = text.split(|&b| b == b'.').collect();
    let (lo, hi, step) = match parts.as_slice() {
        [lo, b"", hi] => (*lo, *hi, None),
        [lo, b"", hi, b"", step] => (*lo, *hi, Some(*step)),
        _ => return Ok(None),
    };
    let words: Vec<Vec<u8>> = if numeric(lo) && numeric(hi) && step.is_none_or(numeric) {
        let (Some(start), Some(end)) = (integer(lo), integer(hi)) else {
            return Ok(None);
        };
        let Some(step) = parse_step(step, start >= end) else {
            return Ok(None);
        };
        let span = (1i128 << 63) - 3;
        if (start < 0 && i128::from(end) - i128::from(start) > span)
            || (start > 0 && i128::from(start) - i128::from(end) > span)
        {
            return Ok(None);
        }
        let padded = padded(lo) || padded(hi);
        let width = lo.len().max(hi.len());
        // No word is wider than the wider endpoint as written, sign and
        // padding included.
        let count = (i128::from(end) - i128::from(start)).unsigned_abs() / u128::from(step) + 1;
        let bytes = count.saturating_mul(width as u128 + 1);
        spend(room, usize::try_from(bytes).unwrap_or(usize::MAX))?;
        values(start, end, step)
            .into_iter()
            .map(|v| {
                if padded {
                    let digits = v.unsigned_abs().to_string();
                    let sign = if v < 0 { "-" } else { "" };
                    let zeros = width.saturating_sub(digits.len() + sign.len());
                    format!("{sign}{}{digits}", "0".repeat(zeros)).into_bytes()
                } else {
                    v.to_string().into_bytes()
                }
            })
            .collect()
    } else if lo.len() == 1
        && hi.len() == 1
        && lo[0].is_ascii_alphabetic()
        && hi[0].is_ascii_alphabetic()
        && step.is_none_or(numeric)
    {
        let Some(step) = parse_step(step, lo[0] >= hi[0]) else {
            return Ok(None);
        };
        values(i64::from(lo[0]), i64::from(hi[0]), step)
            .into_iter()
            .map(|v| vec![v as u8])
            .collect()
    } else {
        return Ok(None);
    };
    Ok(Some(
        words
            .into_iter()
            .map(|word| match word[..] {
                [b'\\'] => vec![Tok::Nothing],
                _ => word.into_iter().map(Tok::Byte).collect(),
            })
            .collect(),
    ))
}

fn numeric(text: &[u8]) -> bool {
    let digits = text
        .strip_prefix(b"-")
        .or_else(|| text.strip_prefix(b"+"))
        .unwrap_or(text);
    !digits.is_empty() && digits.iter().all(u8::is_ascii_digit)
}

fn padded(text: &[u8]) -> bool {
    let digits = text.strip_prefix(b"-").unwrap_or(text);
    digits.len() > 1 && digits[0] == b'0'
}

fn integer(text: &[u8]) -> Option<i64> {
    let negative = text.first() == Some(&b'-');
    let digits = text
        .strip_prefix(b"-")
        .or_else(|| text.strip_prefix(b"+"))
        .unwrap_or(text);
    let start = digits
        .iter()
        .position(|&b| b != b'0')
        .unwrap_or(digits.len());
    let digits = &digits[start..];
    if digits.len() > 19 {
        return None;
    }
    let magnitude: i128 = std::str::from_utf8(digits).ok()?.parse().unwrap_or(0);
    let value = if negative { -magnitude } else { magnitude };
    i64::try_from(value).ok()
}

fn parse_step(step: Option<&[u8]>, descending: bool) -> Option<u64> {
    let Some(step) = step else {
        return Some(1);
    };
    let value = integer(step)?;
    if value == i64::MIN && !descending {
        return None;
    }
    Some(value.unsigned_abs().max(1))
}

fn values(lo: i64, hi: i64, step: u64) -> Vec<i64> {
    let mut out = Vec::new();
    let (lo, hi, step) = (i128::from(lo), i128::from(hi), i128::from(step));
    let mut v = lo;
    if lo <= hi {
        while v <= hi {
            out.push(v as i64);
            v += step;
        }
    } else {
        while v >= hi {
            out.push(v as i64);
            v -= step;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Option<Vec<String>> {
        let template: Vec<Tok> = text.bytes().map(Tok::Byte).collect();
        expand_template(&template, &mut None).unwrap().map(|words| {
            words
                .iter()
                .map(|w| {
                    w.iter()
                        .map(|t| match t {
                            Tok::Byte(b) => char::from(*b),
                            Tok::Atom(_) => '@',
                            Tok::Nothing => '_',
                        })
                        .collect()
                })
                .collect()
        })
    }

    #[test]
    fn alternatives_and_sequences() {
        assert_eq!(words("a{b,c}d").unwrap(), ["abd", "acd"]);
        assert_eq!(words("{a,b}{1,2}").unwrap(), ["a1", "a2", "b1", "b2"]);
        assert_eq!(words("{x,{y,z}}").unwrap(), ["x", "y", "z"]);
        assert_eq!(words("{1..3}").unwrap(), ["1", "2", "3"]);
        assert_eq!(words("{3..1}").unwrap(), ["3", "2", "1"]);
        assert_eq!(words("{-05..5..5}").unwrap(), ["-05", "000", "005"]);
        assert_eq!(words("{a..e..2}").unwrap(), ["a", "c", "e"]);
        assert_eq!(
            words("{0..-9223372036854775808..-9223372036854775808}").unwrap(),
            ["0", "-9223372036854775808"]
        );
        assert_eq!(words("{,x}").unwrap(), ["", "x"]);
        assert_eq!(words("{abc}"), None);
        assert_eq!(words("\\{a,b}"), None);
        assert_eq!(words("{a}{b,c}").unwrap(), ["{a}b", "{a}c"]);
        assert_eq!(words("{x{a,b}}").unwrap(), ["{xa}", "{xb}"]);
        assert_eq!(
            words("p{a,b}q{1,2}r").unwrap(),
            ["paq1r", "paq2r", "pbq1r", "pbq2r"]
        );
    }

    #[test]
    fn thousands_of_groups_stop_at_the_room_left() {
        let flat: Vec<Tok> = "{a,}".repeat(50_000).bytes().map(Tok::Byte).collect();
        assert_eq!(expand_template(&flat, &mut Some(1 << 20)), Err(Exhausted));
        let deep = format!("{}x{}", "{a,".repeat(5_000), "}".repeat(5_000));
        let deep: Vec<Tok> = deep.bytes().map(Tok::Byte).collect();
        assert_eq!(expand_template(&deep, &mut None), Err(Exhausted));
        let nested = format!("{}x{}", "{a,".repeat(NESTING), "}".repeat(NESTING));
        let nested: Vec<Tok> = nested.bytes().map(Tok::Byte).collect();
        assert_eq!(
            expand_template(&nested, &mut None).unwrap().unwrap().len(),
            NESTING + 1
        );
    }

    #[test]
    fn atoms_bring_no_syntax() {
        let template = [
            Tok::Byte(b'{'),
            Tok::Byte(b'1'),
            Tok::Byte(b'.'),
            Tok::Byte(b'.'),
            Tok::Atom(0),
            Tok::Byte(b'}'),
        ];
        assert_eq!(expand_template(&template, &mut None), Ok(None));
        let template = [
            Tok::Byte(b'{'),
            Tok::Byte(b'a'),
            Tok::Byte(b','),
            Tok::Atom(0),
            Tok::Byte(b'}'),
        ];
        assert_eq!(
            expand_template(&template, &mut None).unwrap().unwrap(),
            vec![vec![Tok::Byte(b'a')], vec![Tok::Atom(0)]]
        );
    }
}
