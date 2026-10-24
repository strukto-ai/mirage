/// A run sed refuses or ends: its stderr wording, without the newline,
/// and its exit status.
pub(super) struct Refusal {
    pub(super) message: Vec<u8>,
    pub(super) code: i32,
}

impl Refusal {
    pub(super) fn new(message: Vec<u8>, code: i32) -> Refusal {
        Refusal { message, code }
    }
}

/// How many bytes the unit at `at` takes: a byte, or under UTF-8 a
/// character, a byte no character starts standing alone.
pub(super) fn unit(text: &[u8], at: usize, utf8: bool) -> usize {
    let len = match text[at] {
        _ if !utf8 => return 1,
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return 1,
    };
    match text.get(at..at + len).map(std::str::from_utf8) {
        Some(Ok(_)) => len,
        _ => 1,
    }
}

/// `text` in one case: under UTF-8 each character whose other case is one
/// character, otherwise ASCII letters only.
pub(super) fn convert(text: &[u8], upper: bool, utf8: bool, out: &mut Vec<u8>) {
    if !utf8 || text.is_ascii() {
        out.extend(text.iter().map(|c| {
            if upper {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            }
        }));
        return;
    }
    let mut at = 0;
    while at < text.len() {
        let len = unit(text, at, true);
        let piece = &text[at..at + len];
        let one = std::str::from_utf8(piece)
            .ok()
            .and_then(|s| s.chars().next())
            .and_then(|c| {
                let mut other: Vec<char> = if upper {
                    c.to_uppercase().collect()
                } else {
                    c.to_lowercase().collect()
                };
                (other.len() == 1).then(|| other.remove(0))
            });
        match one {
            Some(c) => {
                let mut buf = [0; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
            None => out.extend_from_slice(piece),
        }
        at += len;
    }
}

/// `l`'s rendering: escapes for the C controls and the backslash, octal
/// for every other byte outside printable ASCII, lines folded at `width`
/// without splitting an escape, and `$` at the end.
pub(super) fn list(ps: &[u8], width: i64) -> Vec<u8> {
    let mut out = Vec::with_capacity(ps.len() + 2);
    let mut used: i64 = 0;
    let mut piece = Vec::with_capacity(4);
    for &byte in ps {
        piece.clear();
        match byte {
            b'\\' => piece.extend_from_slice(b"\\\\"),
            0x07 => piece.extend_from_slice(b"\\a"),
            0x08 => piece.extend_from_slice(b"\\b"),
            0x0C => piece.extend_from_slice(b"\\f"),
            b'\n' => piece.extend_from_slice(b"\\n"),
            b'\r' => piece.extend_from_slice(b"\\r"),
            b'\t' => piece.extend_from_slice(b"\\t"),
            0x0B => piece.extend_from_slice(b"\\v"),
            0x20..=0x7E => piece.push(byte),
            _ => piece.extend_from_slice(format!("\\{byte:03o}").as_bytes()),
        }
        let len = piece.len() as i64;
        if width > 0 && used + len > width - 1 {
            out.extend_from_slice(b"\\\n");
            used = 0;
        }
        out.extend_from_slice(&piece);
        used += len;
    }
    out.extend_from_slice(b"$\n");
    out
}

/// What a name resolves to against `cwd`, as the host resolves a path:
/// `.` and `..` walked, slashes collapsed.
pub(super) fn resolve(name: &[u8], cwd: &[u8]) -> Vec<u8> {
    let mut joined = Vec::new();
    if !name.starts_with(b"/") {
        let mut base = cwd;
        while base.last() == Some(&b'/') {
            base = &base[..base.len() - 1];
        }
        joined.extend_from_slice(base);
        joined.push(b'/');
    }
    joined.extend_from_slice(name);
    let mut parts: Vec<&[u8]> = Vec::new();
    for part in joined.split(|&c| c == b'/') {
        match part {
            b"" | b"." => {}
            b".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let mut out = Vec::with_capacity(joined.len());
    for part in parts {
        out.push(b'/');
        out.extend_from_slice(part);
    }
    if out.is_empty() {
        out.push(b'/');
    }
    out
}
