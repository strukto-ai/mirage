//! Reading a parameter's name the way bash reads it when the word holding
//! it expands: a plain `$name` reference, and whether a `${...}` is one bash
//! refuses for its spelling alone.

/// What ends a braced name, what ends one after a special parameter, the
/// specials a `#` measures and a `!` follows, the special parameters, the
/// operators a `:` arms, and what may follow a name.
const NAME_ENDS: &[u8] = b"#%^,~:-=?+/@}";
const SPECIAL_ENDS: &[u8] = b"#%:-=?+/@}";
const LENGTH_SPECIALS: &[u8] = b"-?#@";
const INDIRECT_SPECIALS: &[u8] = b"#?@*";
const SPECIALS: &[u8] = b"@*#?-$!";
const NULL_OPERATORS: &[u8] = b"-=?+";
const OPERATORS: &[u8] = b"}@#%-=?+/^,~";

fn starts_name(byte: Option<&u8>) -> bool {
    byte.is_some_and(|b| *b == b'_' || b.is_ascii_alphabetic())
}

fn identifier(text: &[u8]) -> bool {
    starts_name(text.first()) && text.iter().all(|b| *b == b'_' || b.is_ascii_alphanumeric())
}

fn digits(text: &[u8]) -> bool {
    !text.is_empty() && text.iter().all(u8::is_ascii_digit)
}

/// A plain dollar reference at `start`: its name and where it ends.
/// Names follow bash's ASCII identifier grammar; an unbraced positional
/// takes one digit, a braced one any number; a special takes one
/// character. None for a dollar that is no plain reference.
pub fn scan_parameter(text: &[u8], start: usize) -> Option<(&[u8], usize)> {
    if text.get(start) != Some(&b'$') {
        return None;
    }
    let mut begin = start + 1;
    let braced = text.get(begin) == Some(&b'{');
    if braced {
        begin += 1;
    }
    let first = *text.get(begin)?;
    let mut end = if first == b'_' || first.is_ascii_alphabetic() {
        begin
            + text[begin..]
                .iter()
                .take_while(|b| **b == b'_' || b.is_ascii_alphanumeric())
                .count()
    } else if first.is_ascii_digit() {
        begin
            + text[begin..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count()
    } else if b"@*#?$!-".contains(&first) {
        begin + 1
    } else {
        return None;
    };
    if !braced && first.is_ascii_digit() {
        end = begin + 1;
    }
    let name = &text[begin..end];
    if braced {
        if text.get(end) != Some(&b'}') {
            return None;
        }
        end += 1;
    }
    Some((name, end))
}

/// Where a name read from `start` stops: at one of `ends`, past a
/// backslash's byte and, reading a variable name, past a whole `[...]`.
fn name_end(text: &[u8], start: usize, ends: &[u8], subscripts: bool) -> usize {
    let mut index = start;
    while index < text.len() {
        let byte = text[index];
        if byte == b'\\' {
            index += 2;
            continue;
        }
        if subscripts && byte == b'[' {
            if let Some(close) = subscript_end(text, index) {
                index = close + 1;
                continue;
            }
        } else if ends.contains(&byte) {
            return index;
        }
        index += 1;
    }
    text.len()
}

fn subscript_end(text: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = start;
    while index < text.len() {
        match text[index] {
            b'\\' => {
                index += 2;
                continue;
            }
            quote @ (b'\'' | b'"') => {
                index += 1 + memchr::memchr(quote, &text[index + 1..])?;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Whether `name` is one whole element reference, `a[...]` with a
/// subscript that is not empty.
fn element(name: &[u8]) -> bool {
    let Some(bracket) = name.iter().position(|b| *b == b'[') else {
        return false;
    };
    if bracket < 1 || !identifier(&name[..bracket]) {
        return false;
    }
    subscript_end(name, bracket).is_some_and(|close| close == name.len() - 1 && close > bracket + 1)
}

/// Whether `${#name}` measures something.
fn length_name(name: &[u8]) -> bool {
    name.is_empty()
        || (name.len() == 1 && SPECIALS.contains(&name[0]))
        || digits(name)
        || element(name)
        || identifier(name)
}

/// Whether bash refuses a `${...}` for its spelling alone: a name that is
/// no identifier, positional or special (`${a b}`, `${ a}`, `${}`), an
/// element reference that is not one whole (`${a[1]x}`), a `#` measuring
/// more than a name (`${#a-x}`), or a name followed by anything but an
/// operator (`${a:}`, `${a*}`). `text` runs from `${` through `}`.
pub fn bad_substitution(text: &[u8]) -> bool {
    let s = text.get(2..).unwrap_or_default();
    let measured = s.first() == Some(&b'#') && starts_name(s.get(1));
    let mut end = name_end(s, 0, if measured { b"}" } else { NAME_ENDS }, true);
    let mut name: Vec<u8> = s[..end].to_vec();
    if name.is_empty() && s.first() == Some(&b'@') {
        name = b"@".to_vec();
        end = 1;
    } else if name.first() == Some(&b'!') && s[end..].starts_with(b"@}") {
        name.push(b'@');
        end += 1;
    }
    if (name.is_empty() && s.first().is_some_and(|b| LENGTH_SPECIALS.contains(b)))
        || (name == b"!" && s.get(1).is_some_and(|b| INDIRECT_SPECIALS.contains(b)))
    {
        let head = name.len() + 1;
        end = name_end(s, head, SPECIAL_ENDS, false);
        name = s[..end].to_vec();
    }
    let mut c = s.get(end).copied();
    let i = end + 1;
    let mut substring = false;
    if c == Some(b':') && s.get(i).is_some_and(|b| NULL_OPERATORS.contains(b)) {
        c = s.get(i).copied();
    } else if c == Some(b':') && s.get(i) != Some(&b'}') {
        substring = true;
    } else if name == b"#" && s.get(i) == Some(&b'}') && c.is_some() {
        let op = c.unwrap_or_default();
        if LENGTH_SPECIALS.contains(&op) {
            name.push(op);
            c = Some(b'}');
        } else if b"%:=+/".contains(&op) {
            return true;
        }
    }
    let indirect = name.first() == Some(&b'!')
        && name.get(1).is_some_and(|b| {
            starts_name(Some(b)) || b.is_ascii_digit() || INDIRECT_SPECIALS.contains(b)
        });
    if name.first() == Some(&b'#') && name.len() > 1 {
        return c != Some(b'}') || !length_name(&name[1..]);
    }
    if indirect
        && c == Some(b'}')
        && ((matches!(name.last(), Some(b'*' | b'@')) && starts_name(name.get(1)))
            || (name.last() == Some(&b']') && element(&name[1..])))
    {
        return false;
    }
    let word = if indirect { &name[1..] } else { &name[..] };
    if word.is_empty() || !length_name(word) {
        return true;
    }
    !substring && c.is_none_or(|c| !OPERATORS.contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_references() {
        assert_eq!(scan_parameter(b"$foo-x", 0), Some((&b"foo"[..], 4)));
        assert_eq!(scan_parameter(b"$12", 0), Some((&b"1"[..], 2)));
        assert_eq!(scan_parameter(b"${12}", 0), Some((&b"12"[..], 5)));
        assert_eq!(scan_parameter(b"$?x", 0), Some((&b"?"[..], 2)));
        assert_eq!(scan_parameter(b"${a-b}", 0), None);
        assert_eq!(scan_parameter(b"$%", 0), None);
    }

    #[test]
    fn bash_refuses_these_spellings() {
        for bad in [
            "${a b}", "${ a}", "${}", "${a[1]x}", "${#a-x}", "${a:}", "${a*}",
        ] {
            assert!(bad_substitution(bad.as_bytes()), "{bad}");
        }
        for good in [
            "${a}",
            "${a:-x}",
            "${#a}",
            "${#}",
            "${!a}",
            "${!a@}",
            "${a[1]}",
            "${#a[@]}",
            "${a:1:2}",
            "${a//x/y}",
            "${a^^}",
            "${@}",
            "${!#}",
            "${#-}",
            "${a@Q}",
        ] {
            assert!(!bad_substitution(good.as_bytes()), "{good}");
        }
    }
}
