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
        let mut message = MessageParser::default().parse(&self.raw).ok_or_else(|| {
            StreamError::new(if matches!(self.config.view, View::Template) {
                "Failed to parse composed message"
            } else {
                "Failed to parse RFC 5322 message"
            })
        })?;
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
