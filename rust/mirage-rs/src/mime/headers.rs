use std::borrow::Cow;
use std::net::IpAddr;

use chrono::{DateTime, Datelike, FixedOffset, Timelike};
use memchr::{memchr, memchr2};
use serde::Serialize;

const MAX_HEADERS: usize = 32 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Name {
    Subject,
    From,
    To,
    Cc,
    Bcc,
    ReplyTo,
    Sender,
    Date,
    MessageId,
    InReplyTo,
    References,
    MimeVersion,
    Received,
    ContentType,
    ContentDisposition,
    ContentTransferEncoding,
    ContentId,
    ContentDescription,
    ContentLocation,
}

impl Name {
    fn parse(name: &str) -> Option<Self> {
        Some(match name.to_ascii_lowercase().as_str() {
            "subject" => Self::Subject,
            "from" => Self::From,
            "to" => Self::To,
            "cc" => Self::Cc,
            "bcc" => Self::Bcc,
            "reply-to" => Self::ReplyTo,
            "sender" => Self::Sender,
            "date" => Self::Date,
            "message-id" => Self::MessageId,
            "in-reply-to" => Self::InReplyTo,
            "references" => Self::References,
            "mime-version" => Self::MimeVersion,
            "received" => Self::Received,
            "content-type" => Self::ContentType,
            "content-disposition" => Self::ContentDisposition,
            "content-transfer-encoding" => Self::ContentTransferEncoding,
            "content-id" => Self::ContentId,
            "content-description" => Self::ContentDescription,
            "content-location" => Self::ContentLocation,
            _ => return None,
        })
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Label<'a> {
    Known(Name),
    Other { other: &'a str },
}

#[derive(Serialize)]
enum Value<'a> {
    Empty,
    Text(Cow<'a, str>),
    TextList(Vec<&'a str>),
    Address(AddressList<'a>),
    DateTime(Stamp),
    ContentType(Media<'a>),
    Received(Box<Received<'a>>),
}

#[derive(Serialize)]
enum AddressList<'a> {
    List(Vec<Address<'a>>),
}

#[derive(Serialize)]
pub(super) struct Address<'a> {
    pub name: Option<&'a str>,
    pub address: &'a str,
}

#[derive(Serialize)]
struct Stamp {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    tz_before_gmt: bool,
    tz_hour: u32,
    tz_minute: u32,
}

fn stamp(value: &str) -> Option<Stamp> {
    let parsed: DateTime<FixedOffset> = DateTime::parse_from_rfc2822(value).ok()?;
    // Accept the canonical shape that both ordinary parsers and the
    // command parser project consistently.
    let canonical = parsed.format("%a, %d %b %Y %H:%M:%S %z").to_string();
    if value != canonical
        || parsed.nanosecond() >= 1_000_000_000
        || !(1900..=9999).contains(&parsed.year())
    {
        return None;
    }
    let offset = parsed.offset().local_minus_utc();
    Some(Stamp {
        year: parsed.year(),
        month: parsed.month(),
        day: parsed.day(),
        hour: parsed.hour(),
        minute: parsed.minute(),
        second: parsed.second(),
        tz_before_gmt: offset < 0,
        tz_hour: offset.unsigned_abs() / 3600,
        tz_minute: offset.unsigned_abs() / 60 % 60,
    })
}

#[derive(Serialize)]
enum Relay<'a> {
    Name(&'a str),
    IpAddr(&'a str),
}

#[derive(Serialize)]
struct Received<'a> {
    from: Option<Relay<'a>>,
    from_ip: Option<&'a str>,
    from_iprev: Option<&'a str>,
    by: Relay<'a>,
    for_: Option<&'a str>,
    with: Option<String>,
    tls_version: Option<&'a str>,
    tls_cipher: Option<&'a str>,
    id: Option<&'a str>,
    ident: Option<&'a str>,
    helo: Option<&'a str>,
    helo_cmd: Option<&'a str>,
    via: Option<&'a str>,
    date: Stamp,
}

fn token(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'+-.^_`|~".contains(&b))
}

fn relay(text: &str) -> Option<Relay<'_>> {
    let bare = text
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(text);
    if bare.parse::<IpAddr>().is_ok() {
        Some(Relay::IpAddr(bare))
    } else if token(text) {
        Some(Relay::Name(text))
    } else {
        None
    }
}

fn mailbox(text: &str) -> bool {
    let Some((user, host)) = text.split_once('@') else {
        return false;
    };
    user.split('.').all(token)
        && host.split('.').all(|label| {
            label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn received(text: &str) -> Option<Received<'_>> {
    let (line, date) = text.rsplit_once(';')?;
    let mut words = line.split_ascii_whitespace();
    let mut from = None;
    let mut from_ip = None;
    let mut from_iprev = None;
    let mut by = None;
    let mut protocol = None;
    let mut id = None;
    let mut for_ = None;
    let mut via = None;
    while let Some(keyword) = words.next() {
        let value = words.next()?;
        match keyword.to_ascii_lowercase().as_str() {
            "from" if from.is_none() => {
                from = Some(relay(value)?);
                if let Some(comment) = words.clone().next().filter(|v| v.starts_with('(')) {
                    words.next();
                    let (prefix, ip) = if comment.ends_with(')') {
                        ("", comment.strip_prefix('(')?)
                    } else {
                        (comment.strip_prefix('(')?, words.next()?)
                    };
                    let ip = ip.strip_prefix('[')?.strip_suffix("])")?;
                    let ip = ip.strip_prefix("IPv6:").unwrap_or(ip);
                    ip.parse::<IpAddr>().ok()?;
                    from_ip = Some(ip);
                    if !prefix.is_empty() {
                        if !token(prefix) {
                            return None;
                        }
                        from_iprev = (prefix.parse::<IpAddr>().is_err()).then_some(prefix);
                    }
                }
            }
            "by" if by.is_none() => by = Some(relay(value)?),
            "with" if protocol.is_none() => {
                let value = value.to_ascii_uppercase();
                if !matches!(
                    value.as_str(),
                    "SMTP"
                        | "ESMTP"
                        | "ESMTPA"
                        | "ESMTPS"
                        | "ESMTPSA"
                        | "LMTP"
                        | "LMTPS"
                        | "LMTPA"
                        | "LMTPSA"
                        | "HTTP"
                        | "HTTPS"
                        | "IMAP"
                        | "POP3"
                ) {
                    return None;
                }
                protocol = Some(value);
            }
            "id" if id.is_none() && token(value) => id = Some(value),
            "for" if for_.is_none() => {
                let value = value.strip_prefix('<')?.strip_suffix('>')?;
                if !mailbox(value) {
                    return None;
                }
                for_ = Some(value);
            }
            "via" if via.is_none() && token(value) => via = Some(value),
            _ => return None,
        }
    }
    Some(Received {
        from,
        from_ip,
        from_iprev,
        by: by?,
        for_,
        with: protocol,
        tls_version: None,
        tls_cipher: None,
        id,
        ident: None,
        helo: None,
        helo_cmd: None,
        via,
        date: stamp(date.trim())?,
    })
}

fn addresses(text: &str) -> Option<AddressList<'_>> {
    let mut list = Vec::new();
    for entry in text.split(',') {
        let entry = entry.trim();
        let (name, address) = if let Some((name, tail)) = entry.split_once('<') {
            let name = name.trim();
            if name.contains("  ")
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b" .'-_".contains(&b))
            {
                return None;
            }
            ((!name.is_empty()).then_some(name), tail.strip_suffix('>')?)
        } else {
            (None, entry)
        };
        if !mailbox(address) {
            return None;
        }
        list.push(Address { name, address });
    }
    Some(AddressList::List(list))
}

#[derive(Serialize)]
struct Parameter<'a> {
    name: &'a str,
    value: Cow<'a, str>,
}

#[derive(Serialize)]
pub(super) struct Media<'a> {
    pub c_type: &'a str,
    pub c_subtype: Option<&'a str>,
    attributes: Option<Vec<Parameter<'a>>>,
    #[serde(skip)]
    pub mime: &'a str,
}

impl<'a> Media<'a> {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.attributes
            .as_ref()?
            .iter()
            .find(|p| p.name == key)
            .map(|p| p.value.as_ref())
    }

    pub fn allowed_params(&self, keys: &[&str]) -> bool {
        self.attributes
            .as_ref()
            .is_none_or(|ps| ps.iter().all(|p| keys.contains(&p.name)))
    }
}

fn extended(value: &str) -> Option<String> {
    let (charset, tail) = value.split_once('\'')?;
    let (language, data) = tail.split_once('\'')?;
    if !charset.eq_ignore_ascii_case("utf-8") || !language.is_empty() {
        return None;
    }
    let mut bytes = Vec::with_capacity(data.len());
    let mut input = data.bytes();
    while let Some(b) = input.next() {
        if b == b'%' {
            let high = char::from(input.next()?).to_digit(16)?;
            let low = char::from(input.next()?).to_digit(16)?;
            bytes.push((high * 16 + low) as u8);
        } else if b.is_ascii_alphanumeric() || b"._-".contains(&b) {
            bytes.push(b);
        } else {
            return None;
        }
    }
    let text = String::from_utf8(bytes).ok()?;
    (!text.is_empty()
        && text.trim() == text
        && !text.starts_with('\u{feff}')
        && !text.chars().any(char::is_control))
    .then_some(text)
}

fn media(text: &str) -> Option<Media<'_>> {
    let mut fields = text.split(';').map(str::trim);
    let mime = fields.next()?;
    let (c_type, c_subtype) = mime
        .split_once('/')
        .map_or((mime, None), |(a, b)| (a, Some(b)));
    if !token(c_type)
        || c_subtype.is_some_and(|s| !token(s))
        || mime.bytes().any(|b| b.is_ascii_uppercase())
    {
        return None;
    }

    let mut attributes: Vec<Parameter<'_>> = Vec::new();
    let mut continuation: Option<(&str, usize)> = None;
    for field in fields {
        let (key, raw_value) = field.split_once('=')?;
        let quoted = raw_value
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'));
        let value = quoted.unwrap_or(raw_value);
        if value.trim() != value || quoted.is_none() && value.contains(' ') {
            return None;
        }
        let (name, suffix) = key
            .split_once('*')
            .map_or((key, None), |(k, s)| (k, Some(s)));
        if !token(name) || name.bytes().any(|b| b.is_ascii_uppercase()) {
            return None;
        }
        let clean = !value.is_empty()
            && value
                .bytes()
                .all(|x| x.is_ascii_alphanumeric() || b" ._-+@".contains(&x));
        let property = match suffix {
            None if clean => {
                continuation = None;
                Cow::Borrowed(value)
            }
            Some("") if matches!(name, "filename" | "name") => {
                continuation = None;
                Cow::Owned(extended(value)?)
            }
            Some("0*") if matches!(name, "filename" | "name") => {
                continuation = Some((name, 1));
                Cow::Owned(extended(value)?)
            }
            Some(position) if clean => {
                let expected = continuation?.1;
                if continuation?.0 != name
                    || position.parse::<usize>().ok()? != expected
                    || position != expected.to_string()
                {
                    return None;
                }
                let last = attributes.last_mut()?;
                last.value.to_mut().push_str(value);
                continuation = Some((name, expected + 1));
                continue;
            }
            _ => return None,
        };
        if attributes.iter().any(|p| p.name == name) {
            return None;
        }
        attributes.push(Parameter {
            name,
            value: property,
        });
    }
    Some(Media {
        c_type,
        c_subtype,
        attributes: (!attributes.is_empty()).then_some(attributes),
        mime,
    })
}

#[derive(Serialize)]
struct Header<'a> {
    name: Label<'a>,
    value: Value<'a>,
    offset_field: usize,
    offset_start: usize,
    offset_end: usize,
    #[serde(skip)]
    raw: &'a str,
}

#[derive(Serialize)]
#[serde(transparent)]
pub(super) struct Headers<'a>(Vec<Header<'a>>);

impl<'a> Headers<'a> {
    fn get(&self, name: Name) -> Option<&Header<'a>> {
        self.0
            .iter()
            .find(|h| matches!(h.name, Label::Known(n) if n == name))
    }

    pub fn raw(&self, name: Name) -> &'a str {
        self.get(name).map_or("", |header| header.raw)
    }

    pub fn text(&self, name: Name) -> Option<&str> {
        match &self.get(name)?.value {
            Value::Text(value) => Some(value),
            _ => None,
        }
    }

    pub fn media(&self, name: Name) -> Option<&Media<'a>> {
        match &self.get(name)?.value {
            Value::ContentType(media) => Some(media),
            _ => None,
        }
    }

    pub fn addresses(&self, name: Name) -> &[Address<'a>] {
        match self.get(name).map(|header| &header.value) {
            Some(Value::Address(AddressList::List(found))) => found,
            _ => &[],
        }
    }
}

fn value(name: Name, raw: &str, command: bool) -> Option<Value<'_>> {
    Some(match name {
        Name::Received if command => Value::Received(Box::new(received(raw)?)),
        Name::Received => Value::Empty,
        Name::Date => Value::DateTime(stamp(raw)?),
        Name::ContentType | Name::ContentDisposition => Value::ContentType(media(raw)?),
        Name::From | Name::To | Name::Cc | Name::Bcc | Name::ReplyTo | Name::Sender => {
            let parsed = addresses(raw)?;
            if matches!(name, Name::From | Name::Sender)
                && matches!(&parsed, AddressList::List(list) if list.len() != 1)
            {
                return None;
            }
            Value::Address(parsed)
        }
        Name::MessageId | Name::InReplyTo | Name::References | Name::ContentId => {
            let identifiers = raw
                .split_ascii_whitespace()
                .map(|word| {
                    let address = word.strip_prefix('<')?.strip_suffix('>')?;
                    mailbox(address).then_some(address)
                })
                .collect::<Option<Vec<_>>>()?;
            match identifiers.as_slice() {
                [only] => Value::Text(Cow::Borrowed(only)),
                [_, _, ..] if name == Name::References => Value::TextList(identifiers),
                _ => return None,
            }
        }
        _ if raw.is_empty() => Value::Empty,
        _ => Value::Text(Cow::Borrowed(raw)),
    })
}

fn row(raw: &[u8], start: usize) -> Option<(&str, usize)> {
    let line_end = start + memchr(b'\n', raw.get(start..)?)?;
    let bytes = &raw[start..line_end];
    let text = std::str::from_utf8(bytes.strip_suffix(b"\r").unwrap_or(bytes)).ok()?;
    if memchr2(b'\r', 0, text.as_bytes()).is_some() {
        return None;
    }
    Some((text, line_end + 1))
}

pub(super) fn parse(raw: &[u8], base: usize, command: bool) -> Option<(Headers<'_>, usize)> {
    let mut headers = Vec::new();
    let mut start = 0;
    let bound = raw.len().min(MAX_HEADERS);
    while start < bound {
        let (line, mut end) = row(&raw[..bound], start)?;
        if line.is_empty() {
            return Some((Headers(headers), end));
        }
        let (field, _) = line.split_once(':')?;
        if field.is_empty()
            || !field
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return None;
        }
        let name = Name::parse(field);
        let begin = start + field.len() + 1;
        while raw.get(end).is_some_and(|b| b" \t".contains(b)) {
            end = row(&raw[..bound], end)?.1;
        }
        let raw_value = std::str::from_utf8(&raw[begin..end])
            .ok()?
            .trim_matches([' ', '\t', '\r', '\n']);
        let folded = raw_value.contains('\n');
        if !raw_value.is_ascii()
            || raw_value.contains("=?")
            || raw_value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\t' | '\r' | '\n'))
        {
            return None;
        }
        let label = if let Some(name) = name {
            if folded
                && !matches!(
                    name,
                    Name::Received | Name::ContentType | Name::ContentDisposition
                )
            {
                return None;
            }
            if name != Name::Received
                && headers
                    .iter()
                    .any(|h: &Header<'_>| matches!(h.name, Label::Known(n) if n == name))
            {
                return None;
            }
            Label::Known(name)
        } else {
            // These fields are opaque to the command parser. Other names
            // may acquire structured JSON as the host parser evolves.
            let lower = field.to_ascii_lowercase();
            if command
                && !lower.starts_with("x-")
                && !matches!(
                    lower.as_str(),
                    "dkim-signature"
                        | "authentication-results"
                        | "arc-seal"
                        | "arc-message-signature"
                        | "arc-authentication-results"
                )
            {
                return None;
            }
            if folded && command {
                return None;
            }
            Label::Other { other: field }
        };
        let parsed = if let Some(name) = name {
            value(name, raw_value, command)?
        } else if raw_value.is_empty() {
            Value::Empty
        } else {
            Value::Text(Cow::Borrowed(raw_value))
        };
        headers.push(Header {
            name: label,
            value: parsed,
            offset_field: base + start,
            offset_start: base + begin,
            offset_end: base + end,
            raw: raw_value,
        });
        start = end;
    }
    None
}
