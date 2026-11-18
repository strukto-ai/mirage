mod headers;
mod parts;

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use self::headers::{Address, Headers, Name};
use self::parts::{Body, Message, parse};

pub const MAX_SOURCE: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MailHost {
    Python,
    Node,
}

#[derive(Deserialize)]
#[serde(tag = "view", rename_all = "snake_case")]
enum View {
    CommandJson,
    File { uid: String, flags: Vec<String> },
    Attachment { filename: String },
}

#[derive(Serialize)]
struct AddressDocument<'a> {
    name: &'a str,
    email: &'a str,
}

impl<'a> From<&'a Address<'_>> for AddressDocument<'a> {
    fn from(address: &'a Address<'_>) -> Self {
        Self {
            name: address.name.unwrap_or(""),
            email: address.address,
        }
    }
}

#[derive(Serialize)]
struct AttachmentDocument<'a> {
    filename: &'a str,
    content_type: &'a str,
    size: usize,
}

#[derive(Serialize)]
struct FileDocument<'a> {
    from: AddressDocument<'a>,
    reply_to: Vec<AddressDocument<'a>>,
    to: Vec<AddressDocument<'a>>,
    cc: Vec<AddressDocument<'a>>,
    subject: &'a str,
    date: &'a str,
    body_text: &'a str,
    body_html: &'a str,
    snippet: &'a str,
    message_id: &'a str,
    in_reply_to: Option<&'a str>,
    references: Vec<&'a str>,
    has_attachments: bool,
    attachments: Vec<AttachmentDocument<'a>>,
    uid: &'a str,
    flags: &'a [String],
}

fn addresses<'a>(headers: &'a Headers<'_>, name: Name) -> Vec<AddressDocument<'a>> {
    headers.addresses(name).iter().map(Into::into).collect()
}

fn file_json(
    message: &Message<'_>,
    host: MailHost,
    uid: &str,
    flags: &[String],
) -> Option<Vec<u8>> {
    let headers = &message.parts[0].headers;
    let plain = match &message.parts[*message.text_body.first()?].body {
        Body::Text(value) => value.as_ref(),
        _ => return None,
    };
    if host == MailHost::Node && !message.attachments.is_empty() && plain.is_empty() {
        return None;
    }
    let plain = if host == MailHost::Node && plain.contains("\r\n") {
        Cow::Owned(plain.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(plain)
    };
    let mut units = 0;
    let snippet = plain
        .char_indices()
        .find_map(|(index, ch)| {
            units += if host == MailHost::Node {
                ch.len_utf16()
            } else {
                1
            };
            // JSON.stringify can preserve a lone high surrogate at the
            // slicing boundary, which a Rust UTF-8 string cannot represent.
            (units > 100).then_some((index, units == 101 && ch.len_utf16() == 2))
        })
        .unwrap_or((plain.len(), false));
    if host == MailHost::Node && snippet.1 {
        return None;
    }
    let attachments = message
        .attachment_parts()
        .map(|part| {
            Some(AttachmentDocument {
                filename: part.filename()?,
                content_type: part.content_type,
                size: part.body.size()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let from = headers.addresses(Name::From).first().map_or(
        AddressDocument {
            name: "",
            email: "",
        },
        Into::into,
    );
    let in_reply_to = headers.raw(Name::InReplyTo);
    serde_json::to_vec(&FileDocument {
        from,
        reply_to: addresses(headers, Name::ReplyTo),
        to: addresses(headers, Name::To),
        cc: addresses(headers, Name::Cc),
        subject: headers.text(Name::Subject).unwrap_or(""),
        date: headers.raw(Name::Date),
        body_text: &plain,
        body_html: "",
        snippet: &plain[..snippet.0],
        message_id: headers.raw(Name::MessageId),
        in_reply_to: (!in_reply_to.is_empty()).then_some(in_reply_to),
        references: headers
            .raw(Name::References)
            .split_ascii_whitespace()
            .collect(),
        has_attachments: !attachments.is_empty(),
        attachments,
        uid,
        flags,
    })
    .ok()
}

/// Render an eligible message from its raw source. `None` delegates the
/// entire operation to the host's existing engine, including error recovery.
pub fn render_mail(raw: &[u8], config: &[u8], host: MailHost) -> Option<Vec<u8>> {
    if raw.len() > MAX_SOURCE {
        return None;
    }
    let view = serde_json::from_slice(config).ok()?;
    let command = matches!(view, View::CommandJson);
    let message = parse(raw, host, command)?;
    match view {
        View::CommandJson => {
            if message.attachments.is_empty() {
                return None;
            }
            serde_json::to_vec(&message).ok()
        }
        View::File { uid, flags } => file_json(&message, host, &uid, &flags),
        View::Attachment { filename } => message
            .attachment_parts()
            .find(|part| part.filename() == Some(filename.as_str()))
            .and_then(|part| part.body.bytes()),
    }
}
