use std::borrow::Cow;

use base64::{Engine, engine::general_purpose::STANDARD};
use memchr::{memchr, memmem};
use serde::{Serialize, Serializer, ser::Error};

use super::{
    MailHost,
    headers::{self, Headers, Name},
};

const MAX_PARTS: usize = 256;

#[derive(Serialize)]
pub(super) struct Message<'a> {
    html_body: Vec<usize>,
    pub text_body: Vec<usize>,
    pub attachments: Vec<usize>,
    pub parts: Vec<Part<'a>>,
}

impl<'a> Message<'a> {
    pub fn attachment_parts(&self) -> impl Iterator<Item = &Part<'a>> {
        self.attachments.iter().map(|&index| &self.parts[index])
    }
}

#[derive(Serialize)]
pub(super) struct Part<'a> {
    pub headers: Headers<'a>,
    is_encoding_problem: bool,
    pub body: Body<'a>,
    offset_header: usize,
    offset_body: usize,
    offset_end: usize,
    #[serde(skip)]
    pub content_type: &'a str,
}

impl Part<'_> {
    pub fn filename(&self) -> Option<&str> {
        self.headers
            .media(Name::ContentDisposition)?
            .param("filename")
    }
}

#[derive(Serialize)]
pub(super) enum Body<'a> {
    Text(Cow<'a, str>),
    Binary(Binary<'a>),
    Multipart(Vec<usize>),
}

impl Body<'_> {
    pub fn size(&self) -> Option<usize> {
        match self {
            Self::Binary(data) => Some(data.decoded_size),
            _ => None,
        }
    }

    pub fn bytes(&self) -> Option<Vec<u8>> {
        match self {
            Self::Binary(data) => data.decode(),
            _ => None,
        }
    }
}

pub(super) struct Binary<'a> {
    encoded: &'a [u8],
    decoded_size: usize,
}

fn base64_digit(byte: u8) -> Option<u8> {
    Some(match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    })
}

impl<'a> Binary<'a> {
    fn parse(encoded: &'a [u8]) -> Option<Self> {
        let mut symbols = 0;
        let mut padding = 0;
        let mut last = 0;
        for &b in encoded {
            match b {
                b'\r' | b'\n' | b'\t' | b' ' => continue,
                b'=' if padding < 2 => padding += 1,
                _ if padding == 0 => last = base64_digit(b)?,
                _ => return None,
            }
            symbols += 1;
        }
        if symbols == 0 || symbols % 4 != 0 || last & ((1 << (padding * 2)) - 1) != 0 {
            return None;
        }
        Some(Self {
            encoded,
            decoded_size: symbols / 4 * 3 - padding,
        })
    }

    fn decode(&self) -> Option<Vec<u8>> {
        let mut encoded = Vec::with_capacity(self.encoded.len());
        encoded.extend(
            self.encoded
                .iter()
                .copied()
                .filter(|b| !matches!(b, b'\r' | b'\n' | b'\t' | b' ')),
        );
        let decoded = STANDARD.decode(encoded).ok()?;
        (decoded.len() == self.decoded_size).then_some(decoded)
    }
}

impl Serialize for Binary<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let data = self
            .decode()
            .ok_or_else(|| S::Error::custom("invalid validated MIME payload"))?;
        data.serialize(serializer)
    }
}

fn quoted_printable(data: &[u8]) -> Option<Vec<u8>> {
    let mut result = Vec::with_capacity(data.len());
    let mut line_style = None;
    for chunk in data.split_inclusive(|&byte| byte == b'\n') {
        let (line, delimiter) = if let Some(line) = chunk.strip_suffix(b"\r\n") {
            (line, b"\r\n".as_slice())
        } else if let Some(line) = chunk.strip_suffix(b"\n") {
            (line, b"\n".as_slice())
        } else {
            (chunk, b"".as_slice())
        };
        if !delimiter.is_empty() {
            if line_style.is_some_and(|seen| seen != delimiter)
                || line.last().is_some_and(|b| matches!(b, b' ' | b'\t' | 12))
            {
                return None;
            }
            line_style = Some(delimiter);
        }
        let (line, soft) = if let Some(prefix) = line.strip_suffix(b"=") {
            if delimiter.is_empty() {
                return None;
            }
            (prefix, true)
        } else {
            (line, false)
        };
        if memchr(b'\r', line).is_some() {
            return None;
        }
        let mut cursor = line;
        while let Some(index) = memchr(b'=', cursor) {
            result.extend_from_slice(&cursor[..index]);
            let high = char::from(*cursor.get(index + 1)?).to_digit(16)?;
            let low = char::from(*cursor.get(index + 2)?).to_digit(16)?;
            result.push((high * 16 + low) as u8);
            cursor = &cursor[index + 3..];
        }
        result.extend_from_slice(cursor);
        if !soft {
            result.extend_from_slice(delimiter);
        }
    }
    Some(result)
}

fn decode_text<'a>(raw: &'a [u8], charset: &str, host: MailHost) -> Option<Cow<'a, str>> {
    if raw.starts_with(b"\xef\xbb\xbf")
        || raw
            .iter()
            .any(|&b| matches!(b, 0..=8 | 11 | 12 | 14..=31 | 127))
    {
        return None;
    }
    let mut lines = raw.split(|&b| b == b'\r');
    lines.next();
    if lines.any(|line| !line.starts_with(b"\n")) {
        return None;
    }
    if charset.eq_ignore_ascii_case("utf-8")
        || charset.eq_ignore_ascii_case("us-ascii") && raw.is_ascii()
    {
        Some(Cow::Borrowed(std::str::from_utf8(raw).ok()?))
    } else if charset.eq_ignore_ascii_case("iso-8859-1")
        && raw.iter().all(|&b| !(0x80..=0x9f).contains(&b))
    {
        if host == MailHost::Python {
            Some(Cow::Owned(raw.iter().map(|&b| char::from(b)).collect()))
        } else {
            Some(encoding_rs::WINDOWS_1252.decode_without_bom_handling(raw).0)
        }
    } else {
        None
    }
}

fn plain_body<'a>(source: &'a [u8], headers: &Headers<'_>, host: MailHost) -> Option<Body<'a>> {
    let media = headers.media(Name::ContentType);
    if let Some(media) = media
        && (media.mime != "text/plain" || !media.allowed_params(&["charset"]))
    {
        return None;
    }
    if headers.media(Name::ContentDisposition).is_some() {
        return None;
    }
    let charset = media.and_then(|m| m.param("charset")).unwrap_or("utf-8");
    let method = headers.raw(Name::ContentTransferEncoding);
    let text = if method.is_empty()
        || method.eq_ignore_ascii_case("7bit")
        || method.eq_ignore_ascii_case("8bit")
    {
        decode_text(source, charset, host)?
    } else if method.eq_ignore_ascii_case("quoted-printable") {
        let decoded = quoted_printable(source)?;
        Cow::Owned(decode_text(&decoded, charset, host)?.into_owned())
    } else {
        return None;
    };
    Some(Body::Text(text))
}

fn boundary_spans(raw: &[u8], boundary: &str) -> Option<Vec<(usize, usize)>> {
    let delim = format!("--{boundary}");
    let mut last = None;
    let mut spans = Vec::new();
    for start in memmem::find_iter(raw, delim.as_bytes()) {
        let tail = raw.get(start + delim.len()..)?;
        if start > 0 && raw[start - 1] != b'\n' || spans.len() >= MAX_PARTS {
            return None;
        }
        if let Some(from) = last {
            let stop = if raw[..start].ends_with(b"\r\n") {
                start - 2
            } else {
                start.checked_sub(1)?
            };
            if stop <= from {
                return None;
            }
            spans.push((from, stop));
        }
        if let Some(end) = tail.strip_prefix(b"--") {
            return (last.is_some()
                && (end.is_empty() || end.starts_with(b"\r\n") || end.starts_with(b"\n")))
            .then_some(spans);
        }
        let eol = if tail.starts_with(b"\r\n") {
            2
        } else if tail.starts_with(b"\n") {
            1
        } else {
            return None;
        };
        last = Some(start + delim.len() + eol);
    }
    None
}

fn attachment_body<'a>(raw: &'a [u8], headers: &Headers<'a>) -> Option<(&'a str, Body<'a>)> {
    let media = headers.media(Name::ContentType)?;
    let disposition = headers.media(Name::ContentDisposition)?;
    // The ordinary engines agree on explicit application attachments.
    // Other media and inline/unnamed parts have distinct host rules.
    if media.c_type != "application"
        || media.c_subtype.is_none()
        || !media.allowed_params(&[])
        || disposition.mime != "attachment"
        || !disposition.allowed_params(&["filename"])
        || disposition.param("filename").is_none()
        || !headers
            .raw(Name::ContentTransferEncoding)
            .eq_ignore_ascii_case("base64")
    {
        return None;
    }
    Some((media.mime, Body::Binary(Binary::parse(raw)?)))
}

pub(super) fn parse(raw: &[u8], host: MailHost, command: bool) -> Option<Message<'_>> {
    let (headers, top_body) = headers::parse(raw, 0, command)?;
    let media = headers.media(Name::ContentType);
    let mut message;
    if let Some(container) = media.filter(|m| m.mime == "multipart/mixed") {
        if !container.allowed_params(&["boundary"])
            || !headers.raw(Name::ContentTransferEncoding).is_empty()
            || headers.media(Name::ContentDisposition).is_some()
        {
            return None;
        }
        let boundary = container.param("boundary")?;
        if boundary.is_empty()
            || boundary.len() > 70
            || boundary.starts_with('-')
            || !boundary
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        {
            return None;
        }
        let spans = boundary_spans(&raw[top_body..], boundary)?;
        if spans.len() < 2 {
            return None;
        }
        let n = spans.len();
        message = Message {
            html_body: vec![1],
            text_body: vec![1],
            attachments: (2..=n).collect(),
            parts: vec![Part {
                headers,
                is_encoding_problem: false,
                body: Body::Multipart((1..=n).collect()),
                offset_header: 0,
                offset_body: top_body,
                offset_end: raw.len(),
                content_type: "multipart/mixed",
            }],
        };
        for (index, (start, end)) in spans.into_iter().enumerate() {
            let base = top_body + start;
            let end = top_body + end;
            let (headers, relative) = headers::parse(&raw[base..end], base, command)?;
            let source = &raw[base + relative..end];
            let (content_type, body) = if index == 0 {
                ("text/plain", plain_body(source, &headers, host)?)
            } else {
                attachment_body(source, &headers)?
            };
            message.parts.push(Part {
                headers,
                is_encoding_problem: false,
                body,
                offset_header: base,
                offset_body: base + relative,
                offset_end: end,
                content_type,
            });
        }
    } else {
        let body = plain_body(&raw[top_body..], &headers, host)?;
        message = Message {
            html_body: vec![0],
            text_body: vec![0],
            attachments: Vec::new(),
            parts: vec![Part {
                headers,
                is_encoding_problem: false,
                body,
                offset_header: 0,
                offset_body: top_body,
                offset_end: raw.len(),
                content_type: "text/plain",
            }],
        };
    }
    Some(message)
}
