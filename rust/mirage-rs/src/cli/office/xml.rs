// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The little of XML a workbook's parts need: their tags in order, with
//! where each starts and ends, so an edit replaces those bytes and copies
//! every other byte as it stands.

use std::borrow::Cow;

/// What a tag is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Kind {
    Start,
    Empty,
    End,
}

/// One tag: its bytes `start..end` in the part, its qualified name, and
/// the raw text of its attributes.
#[derive(Clone, Copy, Debug)]
pub(super) struct Tag<'a> {
    pub(super) kind: Kind,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) name: &'a [u8],
    attrs: &'a [u8],
}

impl<'a> Tag<'a> {
    /// The name past its prefix.
    pub(super) fn local(&self) -> &'a [u8] {
        local(self.name)
    }

    /// The prefix with its colon, empty when there is none.
    pub(super) fn prefix(&self) -> &'a [u8] {
        &self.name[..self.name.len() - self.local().len()]
    }

    pub(super) fn is(&self, name: &str) -> bool {
        self.local() == name.as_bytes()
    }

    /// Each attribute as its qualified name and its raw value.
    pub(super) fn attrs(&self) -> Vec<(&'a [u8], &'a [u8])> {
        let mut out = Vec::new();
        let s = self.attrs;
        let mut at = 0;
        while at < s.len() {
            while at < s.len() && s[at].is_ascii_whitespace() {
                at += 1;
            }
            let key_start = at;
            while at < s.len() && s[at] != b'=' && !s[at].is_ascii_whitespace() {
                at += 1;
            }
            let key = &s[key_start..at];
            while at < s.len() && s[at] != b'=' {
                at += 1;
            }
            at += 1;
            while at < s.len() && s[at].is_ascii_whitespace() {
                at += 1;
            }
            let Some(&quote) = s.get(at) else { break };
            if quote != b'"' && quote != b'\'' {
                break;
            }
            let value_start = at + 1;
            let Some(len) = s[value_start..].iter().position(|&b| b == quote) else {
                break;
            };
            if !key.is_empty() {
                out.push((key, &s[value_start..value_start + len]));
            }
            at = value_start + len + 1;
        }
        out
    }

    /// An attribute's value, unescaped, by its name past any prefix.
    pub(super) fn attr(&self, name: &str) -> Option<String> {
        self.attrs()
            .into_iter()
            .find(|(key, _)| local(key) == name.as_bytes())
            .map(|(_, value)| unescape_attribute(value))
    }
}

fn local(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|&b| b == b':') {
        Some(at) => &name[at + 1..],
        None => name,
    }
}

/// The tags of `data` in order, skipping declarations, comments,
/// processing instructions and character data.
pub(super) fn tags(data: &[u8]) -> Tags<'_> {
    Tags { data, at: 0 }
}

pub(super) struct Tags<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Iterator for Tags<'a> {
    type Item = Tag<'a>;

    fn next(&mut self) -> Option<Tag<'a>> {
        let data = self.data;
        loop {
            let start = self.at + data.get(self.at..)?.iter().position(|&b| b == b'<')?;
            let rest = &data[start..];
            let skip_to = |close: &[u8]| {
                rest.windows(close.len())
                    .position(|w| w == close)
                    .map(|i| start + i + close.len())
            };
            if rest.starts_with(b"<!--") {
                self.at = skip_to(b"-->")?;
                continue;
            }
            if rest.starts_with(b"<![CDATA[") {
                self.at = skip_to(b"]]>")?;
                continue;
            }
            if rest.starts_with(b"<?") {
                self.at = skip_to(b"?>")?;
                continue;
            }
            if rest.starts_with(b"<!") {
                self.at = skip_to(b">")?;
                continue;
            }
            let mut quote = 0u8;
            let mut close = None;
            for (i, &b) in rest.iter().enumerate().skip(1) {
                match b {
                    b'"' | b'\'' if quote == 0 => quote = b,
                    q if q == quote => quote = 0,
                    b'>' if quote == 0 => {
                        close = Some(i);
                        break;
                    }
                    _ => {}
                }
            }
            let close = close?;
            let end = start + close + 1;
            self.at = end;
            let inner = &rest[1..close];
            let (kind, inner) = if let Some(name) = inner.strip_prefix(b"/") {
                (Kind::End, name)
            } else if let Some(body) = inner.strip_suffix(b"/") {
                (Kind::Empty, body)
            } else {
                (Kind::Start, inner)
            };
            let name_len = inner
                .iter()
                .position(|b| b.is_ascii_whitespace())
                .unwrap_or(inner.len());
            return Some(Tag {
                kind,
                start,
                end,
                name: &inner[..name_len],
                attrs: &inner[name_len..],
            });
        }
    }
}

/// Where the element that `open` starts ends: past its matching end tag,
/// or past `open` itself when it is empty.
pub(super) fn element_end(data: &[u8], open: &Tag<'_>) -> Option<usize> {
    if open.kind == Kind::Empty {
        return Some(open.end);
    }
    let mut depth = 0usize;
    for tag in tags(&data[open.end..]) {
        match tag.kind {
            Kind::Start => depth += 1,
            Kind::End if depth == 0 => return Some(open.end + tag.end),
            Kind::End => depth -= 1,
            Kind::Empty => {}
        }
    }
    None
}

/// The character data of every `t` element inside `data`, joined, as a
/// string item or a comment holds its text in runs; phonetic runs are not
/// its text.
pub(super) fn runs_text(data: &[u8]) -> String {
    let mut out = String::new();
    let mut phonetic = 0usize;
    let all: Vec<Tag<'_>> = tags(data).collect();
    for (i, tag) in all.iter().enumerate() {
        match (tag.kind, tag.local()) {
            (Kind::Start, b"rPh") => phonetic += 1,
            (Kind::End, b"rPh") => phonetic = phonetic.saturating_sub(1),
            (Kind::Start, b"t") if phonetic == 0 => {
                if let Some(next) = all.get(i + 1) {
                    out.push_str(&unescape(&data[tag.end..next.start]));
                }
            }
            _ => {}
        }
    }
    out
}

/// Text as XML's end-of-line handling reads it: `\r\n` and a lone `\r`
/// become `\n`.
pub(super) fn line_ends(text: &str) -> Cow<'_, str> {
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
}

/// An attribute value as XML normalizes it: each line end and tab it
/// holds as written reads as a space.
pub(super) fn attribute_spaces(text: &str) -> Cow<'_, str> {
    match line_ends(text) {
        held if held.contains(['\n', '\t']) => Cow::Owned(held.replace(['\n', '\t'], " ")),
        held => held,
    }
}

/// Character data with its line ends read as `\n`, XML's five entities
/// and its character references resolved.
pub(super) fn unescape(raw: &[u8]) -> String {
    resolve(&line_ends(&String::from_utf8_lossy(raw)))
}

/// An attribute value normalized as XML reads it, its entities and
/// character references resolved.
pub(super) fn unescape_attribute(raw: &[u8]) -> String {
    resolve(&attribute_spaces(&String::from_utf8_lossy(raw)))
}

fn resolve(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(semi) = rest.find(';') else { break };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Text made safe for character data and attribute values.
pub(super) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// `tag` rewritten with each `(name, value)` set, or removed when the
/// value is None, every other attribute kept as it stands.
pub(super) fn retag(tag: &Tag<'_>, changes: &[(&str, Option<&str>)], kind: Kind) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(b'<');
    out.extend_from_slice(tag.name);
    let mut seen = vec![false; changes.len()];
    for (key, value) in tag.attrs() {
        let hit = changes
            .iter()
            .position(|(name, _)| local(key) == name.as_bytes() && !key.starts_with(b"xmlns"));
        match hit {
            Some(i) => {
                seen[i] = true;
                if let Some(v) = changes[i].1 {
                    out.extend_from_slice(
                        format!(" {}=\"{}\"", String::from_utf8_lossy(key), escape(v)).as_bytes(),
                    );
                }
            }
            None => {
                out.push(b' ');
                out.extend_from_slice(key);
                out.extend_from_slice(b"=\"");
                out.extend_from_slice(
                    &String::from_utf8_lossy(value)
                        .replace('"', "&quot;")
                        .into_bytes(),
                );
                out.push(b'"');
            }
        }
    }
    for (i, (name, value)) in changes.iter().enumerate() {
        if let (false, Some(v)) = (seen[i], value) {
            out.extend_from_slice(format!(" {name}=\"{}\"", escape(v)).as_bytes());
        }
    }
    out.extend_from_slice(if kind == Kind::Empty { b"/>" } else { b">" });
    out
}

pub(super) const MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
pub(super) const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub(super) const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// `xml` with an empty `name` element holding `attrs` put just inside the
/// end of its `root` element, under the root's prefix so it shares the
/// root's namespace.
pub(super) fn before_end(xml: &[u8], root: &str, name: &str, attrs: &str) -> Option<Vec<u8>> {
    let end = tags(xml)
        .filter(|t| t.kind == Kind::End && t.is(root))
        .last()?;
    let prefix = String::from_utf8_lossy(end.prefix());
    let entry = format!("<{prefix}{name} {attrs}/>");
    Some([&xml[..end.start], entry.as_bytes(), &xml[end.start..]].concat())
}

pub(super) fn strip(xml: &[u8], name: &str, hit: impl Fn(&Tag<'_>) -> bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(xml.len());
    let mut last = 0;
    let mut skip = 0;
    for tag in tags(xml) {
        if tag.start < skip || tag.kind == Kind::End || !tag.is(name) || !hit(&tag) {
            continue;
        }
        let end = element_end(xml, &tag).unwrap_or(tag.end);
        out.extend_from_slice(&xml[last..tag.start]);
        (last, skip) = (end, end);
    }
    out.extend_from_slice(&xml[last..]);
    out
}

pub(super) fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
