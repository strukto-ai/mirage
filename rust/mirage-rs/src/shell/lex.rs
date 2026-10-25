/// Blanks the grammar skips between tokens on a line.
pub(super) fn is_blank(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | 0x0b | 0x0c)
}

pub(super) fn is_space(byte: u8) -> bool {
    is_blank(byte) || byte == b'\n'
}

/// Bytes that end a word, or cannot start one.
pub(super) fn is_special(byte: u8) -> bool {
    matches!(
        byte,
        b'\''
            | b'"'
            | b'<'
            | b'>'
            | b'{'
            | b'}'
            | b'['
            | b']'
            | b'('
            | b')'
            | b'`'
            | b'$'
            | b'|'
            | b'&'
            | b';'
            | b'\\'
    ) || is_space(byte)
}

/// Bytes that end a simple command's word list.
pub(super) fn is_operator(byte: u8) -> bool {
    matches!(byte, b'|' | b'&' | b';' | b'<' | b'>' | b'(' | b')')
}

pub(super) fn is_name_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

pub(super) fn is_name(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Where a word that starts at `at` ends: a backslash takes the byte after
/// it, unless that starts a line continuation.
pub(super) fn word_end(source: &[u8], at: usize) -> usize {
    let mut end = at;
    while end < source.len() {
        let byte = source[end];
        if byte == b'\\' {
            match source.get(end + 1) {
                Some(b'\n') => break,
                Some(b'\r') if source.get(end + 2) == Some(&b'\n') => break,
                None => {
                    end += 1;
                    break;
                }
                Some(_) => {
                    end += 2;
                    continue;
                }
            }
        }
        if is_special(byte) || (byte == b'#' && end == at) {
            break;
        }
        end += 1;
    }
    end
}

/// Where a number that starts at `at` ends, if one does:
/// `-?(0x)?[0-9]+(#[0-9A-Za-z@_]+)?`.
pub(super) fn number_end(source: &[u8], at: usize) -> Option<usize> {
    let mut end = at;
    if source.get(end) == Some(&b'-') {
        end += 1;
    }
    let digits = |from: usize| {
        let mut to = from;
        while source.get(to).is_some_and(u8::is_ascii_digit) {
            to += 1;
        }
        to
    };
    let mut after = digits(end);
    if source.get(end) == Some(&b'0') && source.get(end + 1) == Some(&b'x') {
        let hex = digits(end + 2);
        if hex > end + 2 {
            after = hex;
        }
    }
    if after == end {
        return None;
    }
    end = after;
    if source.get(end) == Some(&b'#') {
        let mut base = end + 1;
        while source
            .get(base)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'@' || *byte == b'_')
        {
            base += 1;
        }
        if base > end + 1 {
            end = base;
        }
    }
    Some(end)
}

/// The end of a name (`[A-Za-z0-9_]+`) at `at`.
pub(super) fn name_end(source: &[u8], at: usize) -> usize {
    let mut end = at;
    while source.get(end).is_some_and(|byte| is_name(*byte)) {
        end += 1;
    }
    end
}

/// Whether the word at `at` is exactly `word`, ended where bash ends a
/// reserved word.
pub(super) fn is_word(source: &[u8], at: usize, word: &[u8]) -> bool {
    source[at..].starts_with(word)
        && source
            .get(at + word.len())
            .is_none_or(|byte| is_space(*byte) || is_operator(*byte))
}

/// Past the quote closing the one at `at`; a backslash escapes in double
/// quotes and backticks.
pub(super) fn quote_end(source: &[u8], at: usize, quote: u8) -> Option<usize> {
    let mut end = at + 1;
    while end < source.len() {
        if source[end] == b'\\' && quote != b'\'' {
            end += 2;
            continue;
        }
        if source[end] == quote {
            return Some(end + 1);
        }
        end += 1;
    }
    None
}

/// Past the `}` closing the `${` at `at`, as bash matches it: nested
/// braces, quotes and escapes skipped.
pub(super) fn brace_end(source: &[u8], at: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut end = at + 1;
    while end < source.len() {
        match source[end] {
            b'\\' => end += 1,
            b'\'' | b'"' | b'`' => {
                end = quote_end(source, end, source[end])?;
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(end + 1);
                }
            }
            _ => {}
        }
        end += 1;
    }
    None
}

/// Past the `]` closing the `[` at `at`, nested brackets counted.
pub(super) fn bracket_end(source: &[u8], at: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut end = at;
    while end < source.len() {
        match source[end] {
            b'\\' => end += 1,
            b'\'' | b'"' => {
                end = quote_end(source, end, source[end])?;
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(end + 1);
                }
            }
            _ => {}
        }
        end += 1;
    }
    None
}
