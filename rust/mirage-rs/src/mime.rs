use std::borrow::Cow;
use std::io::{self, Write};

use mail_parser::{
    Addr, ContentType, GetHeader, Header, HeaderName, HeaderValue, Message, MessageParser,
    MessagePart, PartType, decoders::charsets::map::charset_decoder, parsers::MessageStream,
};
use serde::{Deserialize, Serialize};

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(tag = "view", rename_all = "snake_case")]
enum View {
    Json,
    Read,
    Template,
    Attachments { payloads: bool },
    Addresses,
}

#[derive(Deserialize)]
struct Config {
    #[serde(flatten)]
    view: View,
    #[serde(default)]
    node: bool,
}

struct Mime {
    config: Config,
    raw: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Mime {
        config: parse_config(config)?,
        raw: Vec::new(),
    }))
}

impl Stream for Mime {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.raw.extend_from_slice(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.config.view, View::Addresses) {
            let value = MessageStream::new(&self.raw).parse_address();
            let entries: Vec<_> = value
                .as_address()
                .into_iter()
                .flat_map(|a| a.iter())
                .collect();
            return json(out, &entries);
        }
        let parser = MessageParser::default().max_decoded_nesting(MAX_DEPTH);
        let mut message = parser.parse(&self.raw).ok_or_else(|| {
            StreamError::new(if matches!(self.config.view, View::Template) {
                "Failed to parse composed message"
            } else {
                "Failed to parse RFC 5322 message"
            })
        })?;
        if parser.nested_too_deep() || too_deep(&message) {
            dismantle(message);
            return Err(StreamError::new(format!(
                "Message nests more than {MAX_DEPTH} attached messages"
            )));
        }
        if self.config.node {
            strip_bom(&mut message);
        }
        match self.config.view {
            View::Json => json(out, &message),
            View::Read => read(out, &message, self.config.node)
                .map_err(|error| StreamError::new(error.to_string())),
            View::Template => template(out, &message),
            View::Attachments { payloads } => {
                attachments(out, &message, payloads, self.config.node)
            }
            View::Addresses => unreachable!(),
        }
    }
}

/// Rendering and freeing a message walk its attached messages on the
/// stack, so a message nested deeper than this is refused.
const MAX_DEPTH: usize = 64;

fn too_deep(message: &Message<'_>) -> bool {
    let mut stack = vec![(message, 0)];
    while let Some((message, depth)) = stack.pop() {
        for part in &message.parts {
            if let PartType::Message(nested) = &part.body {
                if depth == MAX_DEPTH {
                    return true;
                }
                stack.push((nested, depth + 1));
            }
        }
    }
    false
}

/// Drops a message one level at a time, as its own drop would recurse.
fn dismantle(message: Message<'_>) {
    let mut stack = vec![message];
    while let Some(mut message) = stack.pop() {
        for part in &mut message.parts {
            if let PartType::Message(nested) = std::mem::take(&mut part.body) {
                stack.push(nested);
            }
        }
    }
}

fn strip_bom(message: &mut Message<'_>) {
    for part in &mut message.parts {
        let decoded_bom = decoder_strips_bom(part);
        match &mut part.body {
            PartType::Message(nested) => strip_bom(nested),
            PartType::Text(text) | PartType::Html(text)
                if !decoded_bom && text.starts_with('\u{feff}') =>
            {
                if let Cow::Borrowed(value) = text {
                    *value = &value['\u{feff}'.len_utf8()..];
                } else if let Cow::Owned(value) = text {
                    value.replace_range(..'\u{feff}'.len_utf8(), "");
                }
            }
            _ => {}
        }
    }
}

// A charset decoder that already consumed a byte-order mark, as plain
// UTF-16's does, leaves any further U+FEFF as text, which Node keeps too.
fn decoder_strips_bom(part: &MessagePart<'_>) -> bool {
    content(part, HeaderName::ContentType)
        .and_then(|value| value.attribute("charset"))
        .and_then(|charset| charset_decoder(charset.as_bytes()))
        .is_some_and(|decode| decode(&[0xff, 0xfe, b'A', 0]) == "A")
}

fn json(out: &mut Vec<u8>, value: &impl Serialize) -> Result<(), StreamError> {
    serde_json::to_writer(out, value).map_err(|error| StreamError::new(error.to_string()))
}

fn header<'m, 'raw>(
    headers: &'m [Header<'raw>],
    name: HeaderName<'_>,
) -> Option<&'m HeaderValue<'raw>> {
    headers
        .iter()
        .find(|header| header.name == name)
        .map(|header| &header.value)
}

// The parser decides a part's type and disposition from the last field of a
// name, so the projection reads that same field.
fn content<'m, 'raw>(
    part: &'m MessagePart<'raw>,
    name: HeaderName<'_>,
) -> Option<&'m ContentType<'raw>> {
    part.headers.header_value(&name)?.as_content_type()
}

fn media_type(content: &ContentType<'_>) -> String {
    match content.c_subtype.as_deref() {
        Some(subtype) if !subtype.is_empty() => format!("{}/{subtype}", content.c_type),
        _ => content.c_type.to_string(),
    }
}

fn filename<'m>(part: &'m MessagePart<'_>, node: bool) -> Option<&'m str> {
    content(part, HeaderName::ContentDisposition)
        .and_then(|value| value.attribute("filename"))
        .filter(|name| node || !name.is_empty())
        .or_else(|| content(part, HeaderName::ContentType)?.attribute("name"))
}

#[derive(Serialize)]
struct Attachment<'a> {
    id: String,
    filename: Option<&'a str>,
    mime: Option<String>,
    size: usize,
    inline: bool,
}

fn attachments(
    out: &mut Vec<u8>,
    message: &Message<'_>,
    payloads: bool,
    node: bool,
) -> Result<(), StreamError> {
    let mut rows = Vec::with_capacity(message.attachments.len());
    for &id in &message.attachments {
        let part = &message.parts[id as usize];
        if payloads {
            out.extend_from_slice(part.contents());
        }
        rows.push(Attachment {
            id: (id + 1).to_string(),
            filename: filename(part, node),
            mime: content(part, HeaderName::ContentType).map(media_type),
            size: part.len(),
            inline: content(part, HeaderName::ContentDisposition)
                .is_some_and(|value| value.c_type.eq_ignore_ascii_case("inline")),
        });
    }
    let payload_len = out.len();
    json(out, &rows)?;
    let metadata_len = u32::try_from(out.len() - payload_len)
        .map_err(|_| StreamError::new("MIME attachment metadata is too large"))?;
    out.extend_from_slice(&metadata_len.to_le_bytes());
    Ok(())
}

fn addresses(part: &MessagePart<'_>, name: HeaderName<'_>, quote: bool) -> Option<Vec<String>> {
    let value = header(&part.headers, name)?.as_address()?;
    Some(value.iter().map(|addr| mailbox(addr, quote)).collect())
}

fn text<'a>(value: &'a HeaderValue<'_>) -> Option<&'a str> {
    match value {
        HeaderValue::Text(text) => Some(text),
        _ => None,
    }
}

fn mailbox(addr: &Addr<'_>, quote: bool) -> String {
    let email = addr.address.as_deref().unwrap_or("");
    let Some(name) = addr.name.as_deref().filter(|name| !name.is_empty()) else {
        return email.to_owned();
    };
    if quote && name.chars().any(|c| r#"()<>[]:;@\,.""#.contains(c)) {
        let quoted = name.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("\"{quoted}\" <{email}>");
    }
    format!("{name} <{email}>")
}

#[derive(Serialize)]
struct Template<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<&'a str>,
    body: &'a str,
}

fn template(out: &mut Vec<u8>, message: &Message<'_>) -> Result<(), StreamError> {
    let part = &message.parts[0];
    let field = |name| addresses(part, name, true).unwrap_or_default();
    let body = message
        .text_body
        .first()
        .and_then(|&id| match &message.parts[id as usize].body {
            PartType::Text(text) => Some(text.as_ref()),
            _ => None,
        });
    json(
        out,
        &Template {
            from: field(HeaderName::From).into_iter().next(),
            to: field(HeaderName::To),
            cc: field(HeaderName::Cc),
            bcc: field(HeaderName::Bcc),
            subject: header(&part.headers, HeaderName::Subject).and_then(text),
            body: body.unwrap_or(""),
        },
    )
}

fn size(bytes: usize, node: bool) -> String {
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 {
        value /= 1024.0;
        unit += 1;
    }
    let units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
    let places = if value.fract() == 0.0 { 0 } else { 2 };
    if node && places != 0 {
        value = (value * 100.0).round() / 100.0;
    }
    format!("{value:.places$} {}", units[unit])
}

fn write_content(out: &mut Vec<u8>, title: &str, content: &ContentType<'_>) -> io::Result<()> {
    write!(out, "    {title}: {}", media_type(content))?;
    for attribute in content.attributes.iter().flatten() {
        write!(out, "; {}={}", attribute.name, attribute.value)?;
    }
    writeln!(out)
}

fn read(out: &mut Vec<u8>, message: &Message<'_>, node: bool) -> io::Result<()> {
    let part = &message.parts[0];
    if let Some(date) = header(&part.headers, HeaderName::Date).and_then(HeaderValue::as_datetime) {
        writeln!(out, "Date: {}", date.to_rfc822())?;
    }
    for (title, name) in [
        ("From", HeaderName::From),
        ("To", HeaderName::To),
        ("Cc", HeaderName::Cc),
    ] {
        if let Some(value) = addresses(part, name, false) {
            writeln!(out, "{title}: {}", value.join(", "))?;
        }
    }
    if let Some(subject) = header(&part.headers, HeaderName::Subject).and_then(text) {
        writeln!(out, "Subject: {subject}")?;
    }
    let html_only = message
        .parts
        .iter()
        .filter(|part| part.is_text_html())
        .count()
        == 1
        && !message
            .parts
            .iter()
            .any(|part| matches!(part.body, PartType::Text(_)));
    for (index, part) in message.parts.iter().enumerate() {
        if !part.is_multipart() {
            read_part(out, part, index + 1, html_only, node)?;
        }
    }
    Ok(())
}

fn read_part(
    out: &mut Vec<u8>,
    part: &MessagePart<'_>,
    position: usize,
    html_only: bool,
    node: bool,
) -> io::Result<()> {
    let media = content(part, HeaderName::ContentType);
    let media_name = media.map_or_else(
        || match part.body {
            PartType::Text(_) => "text/plain".to_owned(),
            PartType::Html(_) => "text/html".to_owned(),
            _ => "application/octet-stream".to_owned(),
        },
        media_type,
    );
    write!(out, "\n[{position}] {media_name}")?;
    if let Some(name) = filename(part, node).filter(|name| node || !name.is_empty()) {
        write!(out, " — {name}")?;
    }
    writeln!(out, " ({})", size(part.len(), node))?;
    if let Some(media) = media {
        write_content(out, "Content-Type", media)?;
    }
    if let Some(encoding) =
        header(&part.headers, HeaderName::ContentTransferEncoding).and_then(text)
    {
        writeln!(out, "    Content-Transfer-Encoding: {encoding}")?;
    }
    if let Some(disposition) = content(part, HeaderName::ContentDisposition) {
        write_content(out, "Content-Disposition", disposition)?;
    }
    if let Some(id) = header(&part.headers, HeaderName::ContentId).and_then(|value| match value {
        HeaderValue::TextList(list) => list.first().map(|value| value.as_ref()),
        _ => text(value),
    }) {
        writeln!(out, "    Content-ID: {id}")?;
    }
    if let Some(description) = header(&part.headers, HeaderName::ContentDescription).and_then(text)
    {
        writeln!(out, "    Content-Description: {description}")?;
    }
    let body = match &part.body {
        PartType::Text(text) if !html_only => text.as_ref(),
        PartType::Html(text) if html_only => text.as_ref(),
        _ => "",
    };
    let body = body.trim_matches(|ch: char| {
        if node {
            ch == '\u{feff}' || ch.is_whitespace() && ch != '\u{85}'
        } else {
            ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch)
        }
    });
    if !body.is_empty() {
        writeln!(out, "\n{body}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MAX_DEPTH;
    use crate::open;

    fn render(view: &str, raw: &[u8]) -> Result<Vec<u8>, String> {
        let config = format!(r#"{{"view":"{view}","payloads":false,"node":true}}"#);
        let mut stream = open("mime", config.as_bytes()).expect("opens");
        let mut out = Vec::new();
        stream.feed(raw, &mut out).expect("feeds");
        stream
            .finish(&mut out)
            .map(|()| out)
            .map_err(|error| error.message)
    }

    fn nested(depth: usize) -> Vec<u8> {
        let mut raw = b"Content-Type: message/rfc822\n\n".repeat(depth);
        raw.extend_from_slice(b"Subject: x\n\nbody\n");
        raw
    }

    fn digests(depth: usize) -> Vec<u8> {
        let mut raw = Vec::new();
        for level in 0..depth {
            raw.extend_from_slice(
                format!("Content-Type: multipart/digest; boundary=b{level}\n\n--b{level}\n\n")
                    .as_bytes(),
            );
        }
        raw.extend_from_slice(b"Subject: x\n\nbody\n");
        raw
    }

    fn base64(bytes: &[u8]) -> Vec<u8> {
        let mut stream = open("base64", br#"{"mode":"encode","wrap":76}"#).expect("opens");
        let mut out = Vec::new();
        stream.feed(bytes, &mut out).expect("feeds");
        stream.finish(&mut out).expect("finishes");
        out
    }

    // Of these short ASCII lines, quoted-printable escapes only `=`.
    fn encoded(encoding: &str, body: Vec<u8>) -> Vec<u8> {
        let mut raw =
            format!("Content-Type: message/rfc822\nContent-Transfer-Encoding: {encoding}\n\n")
                .into_bytes();
        if encoding == "base64" {
            raw.extend(base64(&body));
        } else {
            for byte in body {
                match byte {
                    b'=' => raw.extend_from_slice(b"=3D"),
                    _ => raw.push(byte),
                }
            }
        }
        raw
    }

    #[test]
    fn the_parser_keeps_an_encoded_message_nested_past_the_limit_as_binary() {
        let parser = mail_parser::MessageParser::default().max_decoded_nesting(MAX_DEPTH);
        for (depth, too_deep) in [(MAX_DEPTH + 1, true), (MAX_DEPTH, false)] {
            for encoding in ["base64", "quoted-printable"] {
                let raw = encoded(encoding, nested(depth));
                assert!(parser.parse(&raw).is_some(), "{encoding} {depth}");
                assert_eq!(parser.nested_too_deep(), too_deep, "{encoding} {depth}");
            }
        }
    }

    #[test]
    fn an_encoded_message_nested_within_the_limit_renders_in_every_view() {
        for encoding in ["base64", "quoted-printable"] {
            for raw in [
                encoded(encoding, nested(63)),
                encoded(encoding, digests(63)),
            ] {
                for view in ["json", "read", "template", "attachments"] {
                    assert!(render(view, &raw).is_ok(), "{encoding} {view} refused");
                }
            }
        }
    }

    #[test]
    fn an_encoded_message_nested_past_the_limit_is_refused_in_every_view() {
        for encoding in ["base64", "quoted-printable"] {
            for depth in [64, 65, 20_000, 100_000] {
                for raw in [
                    encoded(encoding, nested(depth)),
                    encoded(encoding, digests(depth)),
                ] {
                    for view in ["json", "read", "template", "attachments"] {
                        assert_eq!(
                            render(view, &raw).err().as_deref(),
                            Some("Message nests more than 64 attached messages"),
                            "{encoding} {depth} {view}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_message_nested_to_the_limit_renders_in_every_view() {
        for raw in [nested(64), digests(64)] {
            for view in ["json", "read", "template", "attachments"] {
                assert!(render(view, &raw).is_ok(), "{view} refused");
            }
        }
    }

    #[test]
    fn a_message_nested_past_the_limit_is_refused_in_every_view() {
        for raw in [nested(65), digests(65), nested(100_000), digests(100_000)] {
            for view in ["json", "read", "template", "attachments"] {
                assert_eq!(
                    render(view, &raw).err().as_deref(),
                    Some("Message nests more than 64 attached messages"),
                    "{view}"
                );
            }
        }
    }
}
