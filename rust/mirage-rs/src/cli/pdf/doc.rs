use std::collections::{HashMap, HashSet, VecDeque};

use pdf_oxide::PdfDocument;
use pdf_oxide::extractors::TextExtractor;
use pdf_oxide::fonts::global_cache::set_global_font_cache_capacity;
use pdf_oxide::layout::TextChar;
use pdf_oxide::object::{Object, ObjectRef};

use super::inflate::{Inflated, flate_only, inflate, measure, scan};
use super::text::Glyph;
use crate::request::Request;
use crate::task::Host;

/// How deep forms and Type 3 glyphs nest their own resources before the
/// rest are left unmeasured: deeper than the reader, which follows forms
/// ten deep.
const NESTING: usize = 16;

/// What the streams a page's text decodes come to, measured once a
/// document: each one's decoded size, and the forms each form draws.
#[derive(Default)]
pub(crate) struct Measured {
    sizes: HashMap<ObjectRef, u64>,
    draws: HashMap<ObjectRef, Vec<String>>,
}

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
    fn chars(&self, index: usize, drawn: bool, content: Vec<u8>) -> Vec<TextChar> {
        let Ok(page) = self.inner.get_page_for_debug(index) else {
            return Vec::new();
        };
        let Some(dict) = page.as_dict() else {
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
    /// Every stream its text decodes is first decoded a window at a time
    /// with the workspace asked whether it fits, so a page that would not
    /// is refused before the reader holds it: its fonts' programs and
    /// character maps, then its content, kept as it inflates, then each
    /// form the content may draw, the streams the reader decodes itself
    /// decoded once a document and counted once a page. The reader's own
    /// path keeps the last
    /// sixty-four pages' contents whole, so only an encrypted document,
    /// which only it decrypts, goes that way.
    pub(crate) async fn content(
        &self,
        host: &Host,
        index: usize,
        measured: &mut Measured,
    ) -> Vec<u8> {
        let Ok(page) = self.inner.get_page_for_debug(index) else {
            return Vec::new();
        };
        let Some(page) = page.as_dict() else {
            return Vec::new();
        };
        if self.inner.is_encrypted() {
            return self.inner.get_page_content_data(index).unwrap_or_default();
        }
        let resources = page.get("Resources").and_then(|r| self.resolved(r));
        let mut held = 0;
        let mut seen = HashSet::new();
        if let Some(resources) = &resources {
            self.measure_fonts(host, resources, &mut held, measured, &mut seen)
                .await;
        }
        let content = self.contents(host, page, held).await;
        if let Some(resources) = resources {
            held += content.len() as u64;
            let draws = drawn(&content, self.xobjects(&resources));
            self.measure_forms(host, resources, draws, &mut held, measured, &mut seen)
                .await;
        }
        content
    }

    /// A page's content streams decoded on top of `held`.
    async fn contents(&self, host: &Host, page: &HashMap<String, Object>, held: u64) -> Vec<u8> {
        let contents = match page.get("Contents") {
            None | Some(Object::Null) => return Vec::new(),
            Some(contents) => contents,
        };
        let loaded;
        let list = match contents.as_reference() {
            Some(at) => {
                let Ok(object) = self.inner.load_object(at) else {
                    return Vec::new();
                };
                loaded = object;
                match loaded.as_array() {
                    Some(list) => list,
                    None if matches!(loaded, Object::Null) => return Vec::new(),
                    None => return self.decoded(host, &loaded, held).await.unwrap_or_default(),
                }
            }
            None => match contents.as_array() {
                Some(list) => list,
                None => return self.decoded(host, contents, held).await.unwrap_or_default(),
            },
        };
        let mut joined = Vec::new();
        for item in list.iter().filter(|item| !matches!(item, Object::Null)) {
            let held = held + joined.len() as u64;
            let data = match item.as_reference() {
                Some(at) => match self.inner.load_object(at) {
                    Ok(Object::Null) => Some(Vec::new()),
                    Ok(stream) => self.decoded(host, &stream, held).await,
                    Err(_) => None,
                },
                None => self.decoded(host, item, held).await,
            };
            if let Some(data) = data {
                joined.extend_from_slice(&data);
                joined.push(b'\n');
            }
        }
        joined
    }

    /// A content stream decoded as the reader decodes it: a FlateDecode
    /// one with no parameters inflated here, a window at a time on top of
    /// `held`; any other measured first, then left to the reader.
    async fn decoded(&self, host: &Host, stream: &Object, held: u64) -> Option<Vec<u8>> {
        if let Object::Stream { dict, data } = stream {
            if flate_only(dict) && !dict.contains_key("DecodeParms") {
                match inflate(host, data, held).await {
                    Inflated::Whole(data) => return Some(data),
                    Inflated::Dropped => return None,
                    Inflated::Broken => {}
                }
            }
            measure(host, dict, data, held).await;
        }
        stream.decode_stream_data().ok()
    }

    /// The fonts `resources` names, which the reader loads whole for the
    /// text: each one's character maps and programs, and a Type 3 font's
    /// glyphs and the fonts of its own resources, counted into `held`.
    async fn measure_fonts(
        &self,
        host: &Host,
        resources: &Object,
        held: &mut u64,
        measured: &mut Measured,
        seen: &mut HashSet<ObjectRef>,
    ) {
        let mut pending = vec![(resources.clone(), 0)];
        while let Some((resources, depth)) = pending.pop() {
            for f in self.entries(resources.as_dict().and_then(|d| d.get("Font"))) {
                let Some(font) = self.resolved(&f) else {
                    continue;
                };
                let Some(dict) = font.as_dict() else {
                    continue;
                };
                let mut streams: Vec<Object> = ["ToUnicode", "Encoding"]
                    .iter()
                    .filter_map(|k| dict.get(*k).cloned())
                    .collect();
                streams.extend(self.entries(dict.get("CharProcs")));
                let mut fonts = vec![font.clone()];
                if let Some(Object::Array(list)) =
                    dict.get("DescendantFonts").and_then(|d| self.resolved(d))
                {
                    fonts.extend(list.iter().filter_map(|d| self.resolved(d)));
                }
                for one in &fonts {
                    let descriptor = one
                        .as_dict()
                        .and_then(|d| d.get("FontDescriptor"))
                        .and_then(|d| self.resolved(d));
                    if let Some(descriptor) = descriptor.as_ref().and_then(Object::as_dict) {
                        streams.extend(
                            ["FontFile", "FontFile2", "FontFile3"]
                                .iter()
                                .filter_map(|k| descriptor.get(*k).cloned()),
                        );
                    }
                }
                for stream in &streams {
                    self.measure(host, stream, held, measured, seen).await;
                }
                let own = dict.get("Resources").and_then(|r| self.resolved(r));
                if let Some(own) = own.filter(|_| depth < NESTING) {
                    pending.push((own, depth + 1));
                }
            }
        }
    }

    /// The forms `draws` names in `resources`, as the reader decodes each
    /// one the content draws: each form counted into `held` with the
    /// fonts of its resources, then the forms it draws in turn.
    async fn measure_forms(
        &self,
        host: &Host,
        resources: Object,
        draws: Vec<String>,
        held: &mut u64,
        measured: &mut Measured,
        seen: &mut HashSet<ObjectRef>,
    ) {
        let mut pending = VecDeque::from([(resources, draws, 0)]);
        while let Some((resources, draws, depth)) = pending.pop_front() {
            let forms = resources
                .as_dict()
                .and_then(|d| d.get("XObject"))
                .and_then(|x| self.resolved(x));
            let Some(forms) = forms.as_ref().and_then(Object::as_dict) else {
                continue;
            };
            for name in draws {
                let Some(at) = forms.get(&name).and_then(Object::as_reference) else {
                    continue;
                };
                if !seen.insert(at) {
                    continue;
                }
                let Ok(form) = self.inner.load_object(at) else {
                    continue;
                };
                let Object::Stream { dict, data } = &form else {
                    continue;
                };
                if dict.get("Subtype").and_then(Object::as_name) != Some("Form") {
                    continue;
                }
                let inherits = !dict.contains_key("Resources");
                let own = dict
                    .get("Resources")
                    .and_then(|r| self.resolved(r))
                    .unwrap_or_else(|| resources.clone());
                let (size, nested) = match (measured.sizes.get(&at), measured.draws.get(&at)) {
                    (Some(size), Some(nested)) if !inherits => {
                        let size = *size;
                        host.ask(Request::Memory { size: *held + size }).await;
                        (size, nested.clone())
                    }
                    _ => {
                        let (size, nested) = self.form(host, dict, data, &own, *held).await;
                        measured.sizes.insert(at, size);
                        measured.draws.insert(at, nested.clone());
                        (size, nested)
                    }
                };
                *held += size;
                self.measure_fonts(host, &own, held, measured, seen).await;
                if depth < NESTING {
                    pending.push_back((own, nested, depth + 1));
                }
            }
        }
    }

    /// What a form decodes to on top of `held`, and the forms it may draw:
    /// a FlateDecode one with no parameters read for the names it uses;
    /// any other counted, and taken to draw every form its resources name.
    async fn form(
        &self,
        host: &Host,
        dict: &HashMap<String, Object>,
        data: &[u8],
        resources: &Object,
        held: u64,
    ) -> (u64, Vec<String>) {
        if flate_only(dict) && !dict.contains_key("DecodeParms") {
            let mut draws = Draws::new(self.xobjects(resources));
            if let Some(size) = scan(host, data, held, &mut |window| draws.feed(window)).await {
                return (size, draws.finish());
            }
        }
        let size = measure(host, dict, data, held).await;
        (size, self.xobjects(resources).into_iter().collect())
    }

    /// The names of the XObjects `resources` holds.
    fn xobjects(&self, resources: &Object) -> HashSet<String> {
        resources
            .as_dict()
            .and_then(|d| d.get("XObject"))
            .and_then(|x| self.resolved(x))
            .and_then(|x| x.as_dict().map(|x| x.keys().cloned().collect()))
            .unwrap_or_default()
    }

    /// One stream's decoded size added to `held`: decoded once a
    /// document, counted once a page.
    async fn measure(
        &self,
        host: &Host,
        stream: &Object,
        held: &mut u64,
        measured: &mut Measured,
        seen: &mut HashSet<ObjectRef>,
    ) {
        let Some(at) = stream.as_reference() else {
            return;
        };
        if !seen.insert(at) {
            return;
        }
        if let Some(size) = measured.sizes.get(&at) {
            *held += size;
            host.ask(Request::Memory { size: *held }).await;
            return;
        }
        let size = match self.inner.load_object(at) {
            Ok(Object::Stream { dict, data }) => measure(host, &dict, &data, *held).await,
            _ => 0,
        };
        measured.sizes.insert(at, size);
        *held += size;
    }

    /// An object with a reference followed.
    fn resolved(&self, object: &Object) -> Option<Object> {
        match object.as_reference() {
            Some(at) => self.inner.load_object(at).ok(),
            None => Some(object.clone()),
        }
    }

    /// The values of a dictionary, or of the dictionary a reference names.
    fn entries(&self, dict: Option<&Object>) -> Vec<Object> {
        dict.and_then(|d| self.resolved(d))
            .and_then(|d| d.as_dict().map(|d| d.values().cloned().collect()))
            .unwrap_or_default()
    }

    /// Page `index`'s glyphs, each in the frame where its line runs left
    /// to right, in the order the page draws them when `drawn`.
    pub(crate) fn glyphs(&self, index: usize, drawn: bool, content: Vec<u8>) -> Vec<Glyph> {
        let chars = self.chars(index, drawn, content);
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

/// The XObjects of `known` that `content` names.
fn drawn(content: &[u8], known: HashSet<String>) -> Vec<String> {
    let mut draws = Draws::new(known);
    draws.feed(content);
    draws.finish()
}

/// The longest token kept between windows: a name runs at most 127 bytes.
const TOKEN: usize = 512;

/// The XObjects a content stream may draw, read a window at a time: each
/// one of `known` the stream names anywhere, once. Only a name the stream
/// holds can draw a form, so a name in a comment, a string or an inline
/// image counts too, and no form a `Do` draws is missed.
struct Draws {
    known: HashSet<String>,
    carry: Vec<u8>,
    names: Vec<String>,
}

impl Draws {
    fn new(known: HashSet<String>) -> Draws {
        Draws {
            known,
            carry: Vec::new(),
            names: Vec::new(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.carry.extend_from_slice(bytes);
        if let Some(end) = self.carry.iter().rposition(|&b| boundary(b)) {
            let split = if self.carry[end] == b'/' {
                end
            } else {
                end + 1
            };
            let rest = self.carry.split_off(split);
            let done = std::mem::replace(&mut self.carry, rest);
            self.tokens(&done);
        }
        let over = self.carry.len().saturating_sub(TOKEN);
        self.carry.drain(..over);
    }

    /// Each token of `bytes`, split where PDF splits them: at white space
    /// and at each delimiter, a `/` starting the name it begins.
    fn tokens(&mut self, bytes: &[u8]) {
        let mut start = None;
        for (at, &byte) in bytes.iter().enumerate() {
            if boundary(byte) {
                if let Some(from) = start.take() {
                    self.token(&bytes[from..at]);
                }
                if byte == b'/' {
                    start = Some(at);
                }
            } else if start.is_none() {
                start = Some(at);
            }
        }
        if let Some(from) = start {
            self.token(&bytes[from..]);
        }
    }

    fn token(&mut self, token: &[u8]) {
        if let Some(raw) = token.strip_prefix(b"/") {
            let found = name(raw);
            if self.known.remove(&found) {
                self.names.push(found);
            }
        }
    }

    fn finish(mut self) -> Vec<String> {
        let last = std::mem::take(&mut self.carry);
        self.tokens(&last);
        self.names
    }
}

/// Whether a byte ends a token: white space or a delimiter.
fn boundary(byte: u8) -> bool {
    matches!(
        byte,
        b' ' | b'\n'
            | b'\r'
            | b'\t'
            | b'\x0c'
            | b'\0'
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
}

/// A name's bytes with each `#xx` escape decoded.
fn name(raw: &[u8]) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut at = 0;
    while at < raw.len() {
        let hex = raw
            .get(at + 1..at + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        match (raw[at], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'#', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::Draws;

    #[test]
    fn each_known_form_the_content_names_counts_once() {
        let known = ["X0", "Fm 1", "X3", "X4", "X5", "X6", "X7", "Unused"];
        let mut draws = Draws::new(known.iter().map(|k| k.to_string()).collect());
        for window in [
            &b"q /X0 Do /X0 Do /Y Do /X"[..],
            b"3 % note\n Do\n/Fm#201 Do (/X7) Tj",
            b" Q /X2 Tf /X4/X5 Do%",
            b"/X6\n",
        ] {
            draws.feed(window);
        }
        assert_eq!(draws.finish(), ["X0", "X3", "Fm 1", "X7", "X4", "X5", "X6"]);
    }
}
