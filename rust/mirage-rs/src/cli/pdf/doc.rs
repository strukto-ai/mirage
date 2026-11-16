use std::collections::HashMap;

use pdf_oxide::PdfDocument;
use pdf_oxide::extractors::TextExtractor;
use pdf_oxide::fonts::global_cache::set_global_font_cache_capacity;
use pdf_oxide::layout::TextChar;
use pdf_oxide::object::Object;

use super::text::Glyph;

/// Why a document would not open.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    /// Its bytes are no PDF this reader can parse.
    Damaged,
    /// It is encrypted and the password given does not open it.
    Password,
}

/// An open document.
pub(crate) struct Doc {
    pub(crate) inner: PdfDocument,
    pub(crate) pages: usize,
}

impl Doc {
    /// Open `bytes`, unlocking them with `password`, the empty one when
    /// none is given, as a reader opens a document whose owner set only
    /// permissions. The reader's cache of fonts across documents stays
    /// empty: it keys a font by its name and object numbers, which two
    /// documents' different subsets of one font share.
    /// The copy of the bytes the reader keeps for its editor goes at once.
    pub(crate) fn open(bytes: Vec<u8>, passwords: &[&[u8]]) -> Result<Doc, Refused> {
        set_global_font_cache_capacity(0);
        let mut inner = PdfDocument::from_bytes(bytes).map_err(|_| Refused::Damaged)?;
        inner.source_bytes = Vec::new();
        if inner.is_encrypted() {
            let mut opened = false;
            for password in passwords.iter().copied().chain([&b""[..]]) {
                if inner.authenticate(password).unwrap_or(false) {
                    opened = true;
                    break;
                }
            }
            if !opened {
                return Err(Refused::Password);
            }
        }
        let pages = match inner.page_count() {
            Ok(n) => n,
            Err(pdf_oxide::Error::EncryptedPdf) => return Err(Refused::Password),
            Err(_) => return Err(Refused::Damaged),
        };
        Ok(Doc { inner, pages })
    }

    /// The characters page `index` draws: in the order it draws them when
    /// `drawn`, else top to bottom and left to right. A page that places
    /// other documents' pages is read whole, as only the whole stream
    /// tells their text from an overlay of it.
    fn chars(&self, index: usize, drawn: bool) -> Vec<TextChar> {
        let Ok(page) = self.inner.get_page_for_debug(index) else {
            return Vec::new();
        };
        let Some(dict) = page.as_dict() else {
            return Vec::new();
        };
        let Some(content) = self.content(index, dict) else {
            return Vec::new();
        };
        if !PdfDocument::may_contain_text_public(&content) {
            return Vec::new();
        }
        let mut extractor = TextExtractor::new();
        extractor.set_page_index(index as u32);
        if let Some(resources) = dict.get("Resources") {
            extractor.set_resources(resources.clone());
            extractor.set_document(&self.inner);
            let _ = self.inner.load_fonts_public(resources, &mut extractor);
        }
        let placed = content
            .windows(b"PlacedPDF".len())
            .any(|w| w == b"PlacedPDF");
        if !drawn || placed {
            return extractor.extract_owned(&content).unwrap_or_default();
        }
        let mut chars = Vec::new();
        for piece in pieces(&content) {
            let mut drawn = extractor.extract_owned(piece).unwrap_or_default();
            along(&mut drawn);
            chars.extend(drawn);
        }
        chars
    }

    /// Page `index`'s content streams decoded, each followed by a newline,
    /// as the reader joins them, a stream that fails to decode left out.
    /// The reader's own path keeps the last sixty-four pages' contents
    /// whole, so only an encrypted document, which only it decrypts, goes
    /// that way.
    fn content(&self, index: usize, page: &HashMap<String, Object>) -> Option<Vec<u8>> {
        if self.inner.is_encrypted() {
            return self.inner.get_page_content_data(index).ok();
        }
        let decode = |item: &Object| -> pdf_oxide::Result<Vec<u8>> {
            match item.as_reference() {
                Some(at) => match self.inner.load_object(at)? {
                    Object::Null => Ok(Vec::new()),
                    stream => stream.decode_stream_data(),
                },
                None => item.decode_stream_data(),
            }
        };
        let contents = match page.get("Contents") {
            None | Some(Object::Null) => return Some(Vec::new()),
            Some(contents) => contents,
        };
        let loaded;
        let list = match contents.as_reference() {
            Some(at) => {
                loaded = self.inner.load_object(at).ok()?;
                match loaded.as_array() {
                    Some(list) => list,
                    None if matches!(loaded, Object::Null) => return Some(Vec::new()),
                    None => return loaded.decode_stream_data().ok(),
                }
            }
            None => match contents.as_array() {
                Some(list) => list,
                None => return contents.decode_stream_data().ok(),
            },
        };
        let mut joined = Vec::new();
        for item in list.iter().filter(|item| !matches!(item, Object::Null)) {
            if let Ok(data) = decode(item) {
                joined.extend_from_slice(&data);
                joined.push(b'\n');
            }
        }
        Some(joined)
    }

    /// Page `index`'s glyphs, each in the frame where its line runs left
    /// to right, in the order the page draws them when `drawn`.
    pub(crate) fn glyphs(&self, index: usize, drawn: bool) -> Vec<Glyph> {
        let chars = self.chars(index, drawn);
        let mut out: Vec<Glyph> = Vec::with_capacity(chars.len());
        for (k, c) in chars.iter().enumerate() {
            let angle = c.rotation_degrees.rem_euclid(360.0);
            let nearest = (angle / 90.0).round();
            let diagonal = (angle - nearest * 90.0).abs() > 2.0;
            let turn = (nearest as i64).rem_euclid(4) as u8;
            let (sin, cos) = (angle.to_radians().sin(), angle.to_radians().cos());
            let x = c.origin_x * cos + c.origin_y * sin;
            let y = -c.origin_x * sin + c.origin_y * cos;
            let size = c.font_size.abs().max(0.1);
            let mut width = if c.rendered_advance > 0.0 {
                c.rendered_advance
            } else {
                c.advance_width
            };
            if width <= 0.0 {
                width = chars
                    .get(k + 1)
                    .map(|n| {
                        let nx = n.origin_x * cos + n.origin_y * sin;
                        nx - x
                    })
                    .filter(|w| *w > 0.0 && *w < 2.0 * size)
                    .unwrap_or(0.5 * size);
            }
            let bare = if c.advance_width > 0.0 {
                c.advance_width.min(width)
            } else {
                width
            };
            let ascent = if c.ascent > 0.0 {
                c.ascent
            } else {
                0.95 * size
            };
            let descent = if c.descent < 0.0 {
                -c.descent
            } else {
                0.35 * size
            };
            let spaced = k > 0 && chars[k - 1].char == ' ';
            let text = if c.char == '\u{a0}' && !spaced {
                ' '
            } else {
                c.char
            };
            out.push(Glyph {
                text,
                x,
                y,
                width,
                bare,
                size,
                ascent: ascent.min(2.0 * size),
                descent: descent.min(size),
                turn,
                diagonal,
            });
        }
        out
    }

    /// The document's Info dictionary, resolved.
    pub(crate) fn info(&self) -> Option<Object> {
        let trailer = self.inner.trailer().as_dict()?;
        let info = trailer.get("Info")?;
        let resolved = self.inner.resolve_object(info).ok()?;
        resolved.as_dict().is_some().then_some(resolved)
    }
}

/// The bytes of one content-stream token starting at `at`, past any
/// whitespace and comments before it: its start and end.
fn token(data: &[u8], mut at: usize) -> Option<(usize, usize)> {
    loop {
        while at < data.len() && matches!(data[at], b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | 0) {
            at += 1;
        }
        if at < data.len() && data[at] == b'%' {
            while at < data.len() && !matches!(data[at], b'\r' | b'\n') {
                at += 1;
            }
            continue;
        }
        break;
    }
    if at >= data.len() {
        return None;
    }
    let start = at;
    match data[at] {
        b'(' => {
            let mut depth = 0usize;
            while at < data.len() {
                match data[at] {
                    b'\\' => at += 1,
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some((start, at + 1));
                        }
                    }
                    _ => {}
                }
                at += 1;
            }
            Some((start, data.len()))
        }
        b'<' if data.get(at + 1) == Some(&b'<') => Some((start, at + 2)),
        b'>' if data.get(at + 1) == Some(&b'>') => Some((start, at + 2)),
        b'<' => {
            let end = data[at..]
                .iter()
                .position(|&b| b == b'>')
                .map_or(data.len(), |p| at + p + 1);
            Some((start, end))
        }
        b'[' | b']' | b'{' | b'}' => Some((start, at + 1)),
        _ => {
            at += 1;
            while at < data.len()
                && !matches!(
                    data[at],
                    b' ' | b'\t'
                        | b'\r'
                        | b'\n'
                        | b'\x0c'
                        | 0
                        | b'('
                        | b')'
                        | b'<'
                        | b'>'
                        | b'['
                        | b']'
                        | b'{'
                        | b'}'
                        | b'/'
                        | b'%'
                )
            {
                at += 1;
            }
            Some((start, at))
        }
    }
}

/// A content stream cut after each operator that draws text or a form,
/// so each piece's characters come out in the order the stream draws
/// them; an inline image's data is passed over whole.
fn pieces(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut from = 0;
    let mut at = 0;
    while let Some((start, end)) = token(data, at) {
        at = end;
        match &data[start..end] {
            b"Tj" | b"TJ" | b"\'" | b"\"" | b"Do" => {
                out.push(&data[from..end]);
                from = end;
            }
            b"ID" => {
                let mut k = end + 1;
                while k + 2 <= data.len() {
                    if &data[k..k + 2] == b"EI"
                        && data[k - 1].is_ascii_whitespace()
                        && data.get(k + 2).is_none_or(|b| b.is_ascii_whitespace())
                    {
                        break;
                    }
                    k += 1;
                }
                at = (k + 2).min(data.len());
            }
            _ => {}
        }
    }
    if from < data.len() {
        out.push(&data[from..]);
    }
    out
}

/// One piece's characters back in the order a single line draws them:
/// the extractor sorts a piece top to bottom, which reverses a line that
/// runs up the page.
fn along(chars: &mut [TextChar]) {
    let Some(first) = chars.first() else { return };
    let angle = first.rotation_degrees;
    if chars
        .iter()
        .any(|c| (c.rotation_degrees - angle).abs() > 0.5)
    {
        return;
    }
    let (sin, cos) = (angle.to_radians().sin(), angle.to_radians().cos());
    let across = |c: &TextChar| -c.origin_x * sin + c.origin_y * cos;
    let base = across(first);
    if chars
        .iter()
        .any(|c| (across(c) - base).abs() > 0.1 * c.font_size.abs().max(1.0))
    {
        return;
    }
    chars.sort_by(|a, b| {
        let along_a = a.origin_x * cos + a.origin_y * sin;
        let along_b = b.origin_x * cos + b.origin_y * sin;
        along_a.total_cmp(&along_b)
    });
}
