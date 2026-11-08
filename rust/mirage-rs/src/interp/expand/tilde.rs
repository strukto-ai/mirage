//! Tilde prefixes: the one a word starts with and the ones after the
//! `=` and each `:` of an assignment-shaped argument.

use super::{Chunk, Expander, Host, Piece};

impl<H: Host> Expander<'_, H> {
    /// An argument shaped like an assignment (`a=~/x`, `a+=~`, `a[$k]=~`):
    /// bash expands a tilde prefix after its `=` and after each unquoted
    /// `:` in it, as in an assignment's value, so `echo a=~` names the home
    /// directory while `echo --a=~` and a word brace expansion made do not.
    pub(super) fn assignment_tildes(&self, chunks: &mut Vec<Chunk>) {
        let mut merged: Vec<Chunk> = Vec::with_capacity(chunks.len());
        for chunk in std::mem::take(chunks) {
            if let (Some(Chunk::Piece(prev)), Chunk::Piece(next)) = (merged.last_mut(), &chunk) {
                if plain(prev) && plain(next) {
                    prev.text.extend_from_slice(&next.text);
                    continue;
                }
            }
            merged.push(chunk);
        }
        *chunks = merged;
        let Some((value_chunk, value_at)) = assignment_value_at(chunks) else {
            return;
        };
        let count = chunks.len();
        let mut out = Vec::with_capacity(count + 2);
        for (index, chunk) in std::mem::take(chunks).into_iter().enumerate() {
            let piece = match chunk {
                Chunk::Piece(piece) if index >= value_chunk && plain(&piece) => piece,
                other => {
                    out.push(other);
                    continue;
                }
            };
            let text = piece.text;
            let last = index + 1 == count;
            let mut from = 0;
            let mut i = if index == value_chunk { value_at } else { 0 };
            let mut start = index == value_chunk;
            while i < text.len() {
                if start && text[i] == b'~' {
                    let end = (i + 1..text.len())
                        .find(|&j| matches!(text[j], b'/' | b':'))
                        .unwrap_or(text.len());
                    if end < text.len() || last {
                        if let Some(named) = self.tilde_prefix(&text[i..end]) {
                            out.push(Chunk::literal(text[from..i].to_vec()));
                            out.push(Chunk::quoted(named));
                            from = end;
                            i = end;
                            start = false;
                            continue;
                        }
                    }
                }
                start = text[i] == b':';
                i += 1;
            }
            out.push(Chunk::literal(text[from..].to_vec()));
        }
        out.retain(|chunk| {
            !matches!(chunk, Chunk::Piece(piece) if piece.text.is_empty() && !piece.quoted && !piece.split)
        });
        *chunks = out;
    }

    /// Expand a word's tilde prefix: a `~` the word starts with, unquoted,
    /// up to the first unquoted slash. A prefix that holds a quoted
    /// character or an expansion is no tilde prefix (`~"/x"`, `\~`), and
    /// what it names is quoted, so it neither splits nor globs.
    pub fn tilde(&self, chunks: &mut Vec<Chunk>) {
        let Some(Chunk::Piece(first)) = chunks.first() else {
            return;
        };
        if first.quoted || first.split || !first.text.starts_with(b"~") {
            return;
        }
        let slash = first.text.iter().position(|b| *b == b'/');
        if slash.is_none() && chunks.len() > 1 {
            return;
        }
        let end = slash.unwrap_or(first.text.len());
        let Some(named) = self.tilde_prefix(&first.text[..end]) else {
            return;
        };
        let rest = first.text[end..].to_vec();
        chunks[0] = Chunk::quoted(named);
        if !rest.is_empty() {
            chunks.insert(1, Chunk::literal(rest));
        }
    }

    /// What a word's tilde prefix names: `~` and `~/rest` the home
    /// directory (`HOME=/` makes `~/x` `//x`), `~+` `$PWD`, `~-` `$OLDPWD`;
    /// None for any other prefix, a user name (no user database) or a
    /// variable that is unset.
    pub fn tilde_prefix(&self, text: &[u8]) -> Option<Vec<u8>> {
        let rest = text.strip_prefix(b"~")?;
        let slash = rest.iter().position(|b| *b == b'/').unwrap_or(rest.len());
        let (prefix, tail) = rest.split_at(slash);
        let base = match prefix {
            b"" => self.shell.home()?,
            b"+" => self.shell.vars.scalar("PWD")?,
            b"-" => self.shell.vars.scalar("OLDPWD")?,
            _ => return None,
        };
        Some([base, tail].concat())
    }
}

/// A piece as typed: unquoted, and no expansion's value.
fn plain(piece: &Piece) -> bool {
    !piece.quoted && !piece.split
}

/// Where the value of an assignment-shaped word starts, as a chunk and a
/// byte in it: past a typed `name=`, `name+=` or `name[subscript]=`, the
/// subscript's brackets balanced and its text free to be quoted or
/// expanded (`c[$k]=~`); None when the first typed `=` ends anything else.
fn assignment_value_at(chunks: &[Chunk]) -> Option<(usize, usize)> {
    let Some(Chunk::Piece(first)) = chunks.first() else {
        return None;
    };
    if !plain(first)
        || !first
            .text
            .first()
            .is_some_and(|b| *b == b'_' || b.is_ascii_alphabetic())
    {
        return None;
    }
    let mut depth = 0usize;
    let mut closed = false;
    let mut plus = false;
    for (index, chunk) in chunks.iter().enumerate() {
        let piece = match chunk {
            Chunk::Piece(piece) if plain(piece) => piece,
            _ if depth > 0 => continue,
            _ => return None,
        };
        for (at, &byte) in piece.text.iter().enumerate() {
            match byte {
                b'=' if depth == 0 => return Some((index, at + 1)),
                b'=' => return None,
                _ if plus => return None,
                b'[' if depth > 0 || !closed => depth += 1,
                b']' if depth > 0 => {
                    depth -= 1;
                    closed = depth == 0;
                }
                _ if depth > 0 => {}
                b'+' => plus = true,
                b'_' | b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' if !closed => {}
                _ => return None,
            }
        }
    }
    None
}
