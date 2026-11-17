//! Field splitting: a word's pieces cut into fields on IFS, and the
//! joins and splats that place a field boundary.

use crate::glob;
use crate::interp::shell::IFS_DEFAULT;
use crate::interp::write::Fault;
use crate::utf8::unit_len;

/// One stretch of an expanded word: its text, whether quoting made its
/// glob characters literal, and whether field splitting reads it, which
/// only an unquoted expansion's value is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub text: Vec<u8>,
    pub quoted: bool,
    pub split: bool,
}

/// A word's pieces, and the boundary between two elements of a splat
/// (`$@`, `${a[@]}`), which reads as its joiner where nothing splits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    Piece(Piece),
    Break(Vec<u8>),
}

impl Chunk {
    /// Text as typed outside quotes: live, never split.
    pub fn literal(text: impl Into<Vec<u8>>) -> Self {
        Chunk::Piece(Piece {
            text: text.into(),
            quoted: false,
            split: false,
        })
    }

    /// Text quoting protects: literal, never split.
    pub fn quoted(text: impl Into<Vec<u8>>) -> Self {
        Chunk::Piece(Piece {
            text: text.into(),
            quoted: true,
            split: false,
        })
    }

    /// An expansion's value: literal inside double quotes, otherwise
    /// split and globbed.
    pub fn value(text: impl Into<Vec<u8>>, quoted: bool) -> Self {
        Chunk::Piece(Piece {
            text: text.into(),
            quoted,
            split: !quoted,
        })
    }
}

/// The bytes of a value field splitting scans between two pauses.
const SPLIT_SLICE: usize = 64 * 1024;

/// Runs as the hosts' globbing reads them: each quoted glob character
/// under its mark, everything else as it is.
pub fn marked(runs: &[(Vec<u8>, bool)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (text, quoted) in runs {
        if !quoted {
            out.extend_from_slice(text);
            continue;
        }
        for &byte in text {
            match char::from_u32(glob::quote(u32::from(byte))) {
                Some(mark) if mark != char::from(byte) => {
                    let mut buf = [0; 4];
                    out.extend_from_slice(mark.encode_utf8(&mut buf).as_bytes());
                }
                _ => out.push(byte),
            }
        }
    }
    out
}

/// A field after splitting: its runs, each quoted or live for globbing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Field(pub Vec<(Vec<u8>, bool)>);

impl Field {
    fn push(&mut self, text: &[u8], quoted: bool) {
        if text.is_empty() {
            return;
        }
        match self.0.last_mut() {
            Some((run, q)) if *q == quoted => run.extend_from_slice(text),
            _ => self.0.push((text.to_vec(), quoted)),
        }
    }

    /// The field's text, quoting removed.
    pub fn text(&self) -> Vec<u8> {
        self.0
            .iter()
            .flat_map(|(run, _)| run.iter().copied())
            .collect()
    }
}

/// What `"$*"` joins the parameters with: IFS's first character, a space
/// when IFS is unset and nothing when it is empty. A character is a whole
/// UTF-8 sequence when `utf8`, else a byte.
pub fn ifs_joiner(ifs: Option<&[u8]>, utf8: bool) -> Vec<u8> {
    match ifs {
        None => b" ".to_vec(),
        Some(ifs) => char_at(ifs, utf8).to_vec(),
    }
}

/// The character `text` starts with: its UTF-8 sequence when `utf8` and
/// the bytes form one, else its first byte; empty for empty text.
fn char_at(text: &[u8], utf8: bool) -> &[u8] {
    if text.is_empty() {
        return text;
    }
    &text[..if utf8 { unit_len(text) } else { 1 }]
}

/// A splat's elements, a field boundary between each two.
pub fn splat(elements: &[Vec<u8>], joiner: &[u8], quoted: bool) -> Vec<Chunk> {
    let mut out = Vec::with_capacity(elements.len() * 2);
    for (index, element) in elements.iter().enumerate() {
        if index > 0 {
            out.push(Chunk::Break(joiner.to_vec()));
        }
        out.push(Chunk::value(element.clone(), quoted));
    }
    out
}

/// A word's text where no field splitting happens (an assignment, a `case`
/// word, `[[ ]]`): a splat boundary reads as its joiner.
pub fn join(chunks: &[Chunk]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in chunks {
        match chunk {
            Chunk::Piece(piece) => out.extend_from_slice(&piece.text),
            Chunk::Break(joiner) => out.extend_from_slice(joiner),
        }
    }
    out
}

/// Split a word's pieces into fields on IFS, as bash does. Only split
/// pieces split. An IFS whitespace run delimits a field and is dropped at
/// either end; any other IFS character, with the whitespace around it,
/// delimits exactly one, so `a,,b` under `IFS=,` is three fields and `a,`
/// one. A splat boundary always ends a field. A field exists once literal
/// or quoted text, or a split value that is not empty, opened it, so an
/// unquoted expansion that comes back empty is no word while `""` is one.
/// Under `utf8` a separator is a whole character, so `IFS=é` splits on
/// `é` alone and never inside `à`. A long value pauses through `pause`
/// as it is scanned, so a cancel or the line's deadline lands inside it.
pub async fn split_fields(
    chunks: &[Chunk],
    ifs: Option<&[u8]>,
    utf8: bool,
    pause: &mut impl AsyncFnMut() -> Result<(), Fault>,
) -> Result<Vec<Field>, Fault> {
    let separators = ifs.unwrap_or(IFS_DEFAULT);
    let mut set: Vec<&[u8]> = Vec::new();
    let mut rest = separators;
    while !rest.is_empty() {
        let c = char_at(rest, utf8);
        set.push(c);
        rest = &rest[c.len()..];
    }
    let separator = |text: &[u8]| set.contains(&char_at(text, utf8));
    let blank = |text: &[u8]| IFS_DEFAULT.contains(&text[0]) && separator(text);
    let mut fields = Vec::new();
    let mut current = Field::default();
    let mut started = false;
    for chunk in chunks {
        let piece = match chunk {
            Chunk::Break(_) => {
                if started {
                    fields.push(std::mem::take(&mut current));
                }
                current = Field::default();
                started = false;
                continue;
            }
            Chunk::Piece(piece) => piece,
        };
        if !piece.split || separators.is_empty() {
            current.push(&piece.text, piece.quoted);
            started = started || !piece.split || !piece.text.is_empty();
            continue;
        }
        let text = &piece.text;
        let mut index = 0;
        let mut paused = 0;
        while index < text.len() {
            if index - paused >= SPLIT_SLICE {
                pause().await?;
                paused = index;
            }
            let mut end = index;
            while end < text.len() && !separator(&text[end..]) {
                end += char_at(&text[end..], utf8).len();
            }
            if end > index {
                current.push(&text[index..end], false);
                started = true;
                index = end;
                continue;
            }
            while end < text.len() && blank(&text[end..]) {
                end += 1;
            }
            let hard = end < text.len() && separator(&text[end..]);
            if hard {
                end += char_at(&text[end..], utf8).len();
                while end < text.len() && blank(&text[end..]) {
                    end += 1;
                }
            }
            if started || hard {
                fields.push(std::mem::take(&mut current));
            }
            current = Field::default();
            started = false;
            index = end;
        }
    }
    if started {
        fields.push(current);
    }
    Ok(fields)
}
