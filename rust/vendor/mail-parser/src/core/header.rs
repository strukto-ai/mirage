/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{
    Address, Attribute, ContentType, DateTime, GetHeader, Greeting, Header, HeaderName,
    HeaderValue, Host, Message, MessagePart, MessagePartId, MimeHeaders, PartType, Protocol,
    Received, TlsVersion,
};
use core::fmt;
use std::hash::Hash;
use std::net::IpAddr;
use std::{borrow::Cow, fmt::Display};

impl<'x> Header<'x> {
    /// Returns the header name
    pub fn name(&self) -> &str {
        self.name.as_str()
    }

    /// Returns the parsed header value
    pub fn value(&self) -> &HeaderValue<'x> {
        &self.value
    }

    /// Returns the raw offset start
    pub fn offset_start(&self) -> u32 {
        self.offset_start
    }

    /// Returns the raw offset end
    pub fn offset_end(&self) -> u32 {
        self.offset_end
    }

    /// Returns the raw offset of the header name
    pub fn offset_field(&self) -> u32 {
        self.offset_field
    }

    /// Returns an owned version of the header
    pub fn into_owned(self) -> Header<'static> {
        Header {
            name: self.name.into_owned(),
            value: self.value.into_owned(),
            offset_field: self.offset_field,
            offset_start: self.offset_start,
            offset_end: self.offset_end,
        }
    }
}

impl<'x> HeaderValue<'x> {
    pub fn is_empty(&self) -> bool {
        *self == HeaderValue::Empty
    }

    pub fn unwrap_text(self) -> Cow<'x, str> {
        match self {
            HeaderValue::Text(s) => s,
            _ => panic!("HeaderValue::unwrap_text called on non-Text value"),
        }
    }

    pub fn unwrap_text_list(self) -> Vec<Cow<'x, str>> {
        match self {
            HeaderValue::TextList(l) => l,
            HeaderValue::Text(s) => vec![s],
            _ => panic!("HeaderValue::unwrap_text_list called on non-TextList value"),
        }
    }

    pub fn unwrap_datetime(self) -> DateTime {
        match self {
            HeaderValue::DateTime(d) => d,
            _ => panic!("HeaderValue::unwrap_datetime called on non-DateTime value"),
        }
    }

    pub fn unwrap_address(self) -> Address<'x> {
        match self {
            HeaderValue::Address(a) => a,
            _ => panic!("HeaderValue::unwrap_address called on non-Address value"),
        }
    }

    pub fn unwrap_content_type(self) -> ContentType<'x> {
        match self {
            HeaderValue::ContentType(c) => c,
            _ => panic!("HeaderValue::unwrap_content_type called on non-ContentType value"),
        }
    }

    pub fn unwrap_received(self) -> Received<'x> {
        match self {
            HeaderValue::Received(r) => *r,
            _ => panic!("HeaderValue::unwrap_received called on non-Received value"),
        }
    }

    pub fn into_text(self) -> Option<Cow<'x, str>> {
        match self {
            HeaderValue::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn into_text_list(self) -> Option<Vec<Cow<'x, str>>> {
        match self {
            HeaderValue::Text(s) => Some(vec![s]),
            HeaderValue::TextList(l) => Some(l),
            _ => None,
        }
    }

    pub fn into_address(self) -> Option<Address<'x>> {
        match self {
            HeaderValue::Address(a) => Some(a),
            _ => None,
        }
    }

    pub fn into_datetime(self) -> Option<DateTime> {
        match self {
            HeaderValue::DateTime(d) => Some(d),
            _ => None,
        }
    }

    pub fn into_content_type(self) -> Option<ContentType<'x>> {
        match self {
            HeaderValue::ContentType(c) => Some(c),
            _ => None,
        }
    }

    pub fn into_received(self) -> Option<Received<'x>> {
        match self {
            HeaderValue::Received(r) => Some(*r),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match *self {
            HeaderValue::Text(ref s) => Some(s),
            HeaderValue::TextList(ref l) => l.last()?.as_ref().into(),
            _ => None,
        }
    }

    pub fn as_text_list(&self) -> Option<&[Cow<'x, str>]> {
        match *self {
            HeaderValue::Text(ref s) => Some(std::slice::from_ref(s)),
            HeaderValue::TextList(ref l) => Some(l.as_slice()),
            _ => None,
        }
    }

    pub fn as_address(&self) -> Option<&Address<'x>> {
        match *self {
            HeaderValue::Address(ref a) => Some(a),
            _ => None,
        }
    }

    pub fn as_received(&self) -> Option<&Received<'x>> {
        match *self {
            HeaderValue::Received(ref r) => Some(r),
            _ => None,
        }
    }

    pub fn as_content_type(&self) -> Option<&ContentType<'x>> {
        match *self {
            HeaderValue::ContentType(ref c) => Some(c),
            _ => None,
        }
    }

    pub fn as_datetime(&self) -> Option<&DateTime> {
        match *self {
            HeaderValue::DateTime(ref d) => Some(d),
            _ => None,
        }
    }

    pub fn into_owned(self) -> HeaderValue<'static> {
        match self {
            HeaderValue::Address(addr) => HeaderValue::Address(addr.into_owned()),
            HeaderValue::Text(text) => HeaderValue::Text(text.into_owned().into()),
            HeaderValue::TextList(list) => HeaderValue::TextList(
                list.into_iter()
                    .map(|text| text.into_owned().into())
                    .collect(),
            ),
            HeaderValue::DateTime(datetime) => HeaderValue::DateTime(datetime),
            HeaderValue::ContentType(ct) => HeaderValue::ContentType(ContentType {
                c_type: ct.c_type.into_owned().into(),
                c_subtype: ct.c_subtype.map(|s| s.into_owned().into()),
                attributes: ct.attributes.map(|attributes| {
                    attributes
                        .into_iter()
                        .map(|a| Attribute {
                            name: a.name.into_owned().into(),
                            value: a.value.into_owned().into(),
                        })
                        .collect()
                }),
            }),
            HeaderValue::Received(rcvd) => HeaderValue::Received(Box::new(rcvd.into_owned())),
            HeaderValue::Empty => HeaderValue::Empty,
        }
    }

    pub fn len(&self) -> usize {
        match self {
            HeaderValue::Text(text) => text.len(),
            HeaderValue::TextList(list) => list.iter().map(|t| t.len()).sum(),
            HeaderValue::Address(Address::List(list)) => list
                .iter()
                .map(|a| {
                    a.name.as_ref().map_or(0, |a| a.len())
                        + a.address.as_ref().map_or(0, |a| a.len())
                })
                .sum(),
            HeaderValue::Address(Address::Group(grouplist)) => grouplist
                .iter()
                .flat_map(|g| g.addresses.iter())
                .map(|a| {
                    a.name.as_ref().map_or(0, |a| a.len())
                        + a.address.as_ref().map_or(0, |a| a.len())
                })
                .sum(),
            HeaderValue::DateTime(_) => 24,
            HeaderValue::ContentType(ct) => {
                ct.c_type.len()
                    + ct.c_subtype.as_ref().map_or(0, |s| s.len())
                    + ct.attributes.as_ref().map_or(0, |at| {
                        at.iter().map(|a| a.name.len() + a.value.len()).sum()
                    })
            }
            HeaderValue::Received(_) => 1,
            HeaderValue::Empty => 0,
        }
    }
}

impl PartialEq for HeaderName<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Other(a), Self::Other(b)) => a.eq_ignore_ascii_case(b),
            (Self::Other(_), _) | (_, Self::Other(_)) => false,
            _ => self.id() == other.id(),
        }
    }
}

impl Hash for HeaderName<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match self {
            HeaderName::Other(value) => {
                for ch in value.as_bytes() {
                    ch.to_ascii_lowercase().hash(state)
                }
            }
            _ => self.id().hash(state),
        }
    }
}

impl Eq for HeaderName<'_> {}

impl<'x> From<HeaderName<'x>> for u8 {
    fn from(name: HeaderName<'x>) -> Self {
        name.id()
    }
}

impl HeaderName<'_> {
    pub fn into_string(self) -> String {
        match self {
            HeaderName::Other(name) => name.into_owned(),
            _ => self.as_str().to_string(),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            HeaderName::Other(other) => other.as_ref(),
            _ => self.as_static_str(),
        }
    }

    pub fn len(&self) -> usize {
        self.as_str().len()
    }

    /// Returns true if the default parser yields a structured value for this header.
    pub fn is_structured(&self) -> bool {
        matches!(
            self,
            HeaderName::Subject
                | HeaderName::Comments
                | HeaderName::ContentDescription
                | HeaderName::ContentLocation
                | HeaderName::ContentTransferEncoding
                | HeaderName::From
                | HeaderName::To
                | HeaderName::Cc
                | HeaderName::Bcc
                | HeaderName::ReplyTo
                | HeaderName::Sender
                | HeaderName::ResentTo
                | HeaderName::ResentFrom
                | HeaderName::ResentBcc
                | HeaderName::ResentCc
                | HeaderName::ResentSender
                | HeaderName::ListArchive
                | HeaderName::ListHelp
                | HeaderName::ListId
                | HeaderName::ListOwner
                | HeaderName::ListPost
                | HeaderName::ListSubscribe
                | HeaderName::ListUnsubscribe
                | HeaderName::Date
                | HeaderName::ResentDate
                | HeaderName::MessageId
                | HeaderName::References
                | HeaderName::InReplyTo
                | HeaderName::ReturnPath
                | HeaderName::ContentId
                | HeaderName::ResentMessageId
                | HeaderName::Keywords
                | HeaderName::ContentLanguage
                | HeaderName::Received
                | HeaderName::ContentType
                | HeaderName::ContentDisposition
        )
    }

    /// Returns true if it is a MIME header.
    pub fn is_mime_header(&self) -> bool {
        matches!(
            self,
            HeaderName::ContentDescription
                | HeaderName::ContentId
                | HeaderName::ContentLanguage
                | HeaderName::ContentLocation
                | HeaderName::ContentTransferEncoding
                | HeaderName::ContentType
                | HeaderName::ContentDisposition
        )
    }

    /// Returns true if it is an `Other` header name
    pub fn is_other(&self) -> bool {
        matches!(self, HeaderName::Other(_))
    }

    pub fn is_empty(&self) -> bool {
        false
    }
}

impl<'x> MimeHeaders<'x> for Message<'x> {
    fn content_description(&self) -> Option<&str> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentDescription)
            .and_then(|header| header.as_text())
    }

    fn content_disposition(&self) -> Option<&ContentType<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentDisposition)
            .and_then(|header| header.as_content_type())
    }

    fn content_id(&self) -> Option<&str> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentId)
            .and_then(|header| header.as_text())
    }

    fn content_transfer_encoding(&self) -> Option<&str> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentTransferEncoding)
            .and_then(|header| header.as_text())
    }

    fn content_type(&self) -> Option<&ContentType<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentType)
            .and_then(|header| header.as_content_type())
    }

    fn content_language(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentLanguage)
            .unwrap_or(&HeaderValue::Empty)
    }

    fn content_location(&self) -> Option<&str> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ContentLocation)
            .and_then(|header| header.as_text())
    }
}

impl<'x> MessagePart<'x> {
    /// Returns the body part's contents as a `u8` slice
    pub fn contents(&self) -> &[u8] {
        match &self.body {
            PartType::Text(text) | PartType::Html(text) => text.as_bytes(),
            PartType::Binary(bin) | PartType::InlineBinary(bin) => bin.as_ref(),
            PartType::Message(message) => message.raw_message(),
            PartType::Multipart(_) => b"",
        }
    }

    /// Returns the body part's contents as a `str`
    pub fn text_contents(&self) -> Option<&str> {
        match &self.body {
            PartType::Text(text) | PartType::Html(text) => text.as_ref().into(),
            PartType::Binary(bin) | PartType::InlineBinary(bin) => {
                std::str::from_utf8(bin.as_ref()).ok()
            }
            PartType::Message(message) => std::str::from_utf8(message.raw_message()).ok(),
            PartType::Multipart(_) => None,
        }
    }

    /// Returns the nested message
    pub fn message(&self) -> Option<&Message<'x>> {
        if let PartType::Message(message) = &self.body {
            Some(message)
        } else {
            None
        }
    }

    /// Returns the sub parts ids of a MIME part
    pub fn sub_parts(&self) -> Option<&[MessagePartId]> {
        if let PartType::Multipart(parts) = &self.body {
            Some(parts.as_ref())
        } else {
            None
        }
    }

    /// Returns the body part's length
    pub fn len(&self) -> usize {
        match &self.body {
            PartType::Text(text) | PartType::Html(text) => text.len(),
            PartType::Binary(bin) | PartType::InlineBinary(bin) => bin.len(),
            PartType::Message(message) => message.raw_message().len(),
            PartType::Multipart(_) => 0,
        }
    }

    /// Returns `true` when the body part MIME type is text/*
    pub fn is_text(&self) -> bool {
        matches!(self.body, PartType::Text(_) | PartType::Html(_))
    }

    /// Returns `true` when the body part MIME type is text/html
    pub fn is_text_html(&self) -> bool {
        matches!(self.body, PartType::Html(_))
    }

    /// Returns `true` when the part is binary
    pub fn is_binary(&self) -> bool {
        matches!(self.body, PartType::Binary(_) | PartType::InlineBinary(_))
    }

    /// Returns `true` when the part is multipart
    pub fn is_multipart(&self) -> bool {
        matches!(self.body, PartType::Multipart(_))
    }

    /// Returns `true` when the part is a nested message
    pub fn is_message(&self) -> bool {
        matches!(self.body, PartType::Message(_))
    }

    /// Returns `true` when the body part is empty
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Get the message headers
    pub fn headers(&self) -> &[Header<'x>] {
        &self.headers
    }

    /// Returns the body raw length
    pub fn raw_len(&self) -> u32 {
        self.offset_end.saturating_sub(self.offset_header)
    }

    /// Get the raw header offset of this part
    pub fn raw_header_offset(&self) -> u32 {
        self.offset_header
    }

    /// Get the raw body offset of this part
    pub fn raw_body_offset(&self) -> u32 {
        self.offset_body
    }

    /// Get the raw body end offset of this part
    pub fn raw_end_offset(&self) -> u32 {
        self.offset_end
    }

    /// Returns an owned version of the this part
    pub fn into_owned(self) -> MessagePart<'static> {
        MessagePart {
            headers: self.headers.into_iter().map(|h| h.into_owned()).collect(),
            is_encoding_problem: self.is_encoding_problem,
            body: match self.body {
                PartType::Text(v) => PartType::Text(v.into_owned().into()),
                PartType::Html(v) => PartType::Html(v.into_owned().into()),
                PartType::Binary(v) => PartType::Binary(v.into_owned().into()),
                PartType::InlineBinary(v) => PartType::InlineBinary(v.into_owned().into()),
                PartType::Message(v) => PartType::Message(v.into_owned()),
                PartType::Multipart(v) => PartType::Multipart(v),
            },
            encoding: self.encoding,
            offset_header: self.offset_header,
            offset_body: self.offset_body,
            offset_end: self.offset_end,
        }
    }
}

impl fmt::Display for MessagePart<'_> {
    fn fmt(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt.write_str(self.text_contents().unwrap_or("[no contents]"))
    }
}

impl<'x> MimeHeaders<'x> for MessagePart<'x> {
    fn content_description(&self) -> Option<&str> {
        self.headers
            .header_value(&HeaderName::ContentDescription)
            .and_then(|header| header.as_text())
    }

    fn content_disposition(&self) -> Option<&ContentType<'x>> {
        self.headers
            .header_value(&HeaderName::ContentDisposition)
            .and_then(|header| header.as_content_type())
    }

    fn content_id(&self) -> Option<&str> {
        self.headers
            .header_value(&HeaderName::ContentId)
            .and_then(|header| header.as_text())
    }

    fn content_transfer_encoding(&self) -> Option<&str> {
        self.headers
            .header_value(&HeaderName::ContentTransferEncoding)
            .and_then(|header| header.as_text())
    }

    fn content_type(&self) -> Option<&ContentType<'x>> {
        self.headers
            .header_value(&HeaderName::ContentType)
            .and_then(|header| header.as_content_type())
    }

    fn content_language(&self) -> &HeaderValue<'x> {
        self.headers
            .header_value(&HeaderName::ContentLanguage)
            .unwrap_or(&HeaderValue::Empty)
    }

    fn content_location(&self) -> Option<&str> {
        self.headers
            .header_value(&HeaderName::ContentLocation)
            .and_then(|header| header.as_text())
    }
}

/// An RFC2047 Content-Type or RFC2183 Content-Disposition MIME header field.
impl<'x> ContentType<'x> {
    /// Returns the type
    pub fn ctype(&self) -> &str {
        &self.c_type
    }

    /// Returns the sub-type
    pub fn subtype(&self) -> Option<&str> {
        self.c_subtype.as_ref()?.as_ref().into()
    }

    /// Returns an attribute by name
    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .as_ref()?
            .iter()
            .find(|a| a.name == name)?
            .value
            .as_ref()
            .into()
    }

    /// Removes an attribute by name
    pub fn remove_attribute(&mut self, name: &str) -> Option<Cow<'x, str>> {
        let attributes = self.attributes.as_mut()?;

        attributes
            .iter()
            .position(|a| a.name == name)
            .map(|pos| attributes.swap_remove(pos).value)
    }

    /// Returns all attributes
    pub fn attributes(&self) -> Option<&[Attribute<'x>]> {
        self.attributes.as_deref()
    }

    /// Returns `true` when the provided attribute name is present
    pub fn has_attribute(&self, name: &str) -> bool {
        self.attributes
            .as_ref()
            .is_some_and(|attr| attr.iter().any(|a| a.name == name))
    }

    /// Returns ```true``` if the Content-Disposition type is "attachment"
    pub fn is_attachment(&self) -> bool {
        self.c_type.eq_ignore_ascii_case("attachment")
    }

    /// Returns ```true``` if the Content-Disposition type is "inline"
    pub fn is_inline(&self) -> bool {
        self.c_type.eq_ignore_ascii_case("inline")
    }
}

/// A Received header
impl<'x> Received<'x> {
    pub fn into_owned(self) -> Received<'static> {
        Received {
            from: self.from.map(|s| s.into_owned()),
            from_ip: self.from_ip,
            from_iprev: self.from_iprev.map(|s| s.into_owned().into()),
            by: self.by.map(|s| s.into_owned()),
            for_: self.for_.map(|s| s.into_owned().into()),
            with: self.with,
            tls_version: self.tls_version,
            tls_cipher: self.tls_cipher.map(|s| s.into_owned().into()),
            id: self.id.map(|s| s.into_owned().into()),
            ident: self.ident.map(|s| s.into_owned().into()),
            helo: self.helo.map(|s| s.into_owned()),
            helo_cmd: self.helo_cmd,
            via: self.via.map(|s| s.into_owned().into()),
            date: self.date,
        }
    }

    /// Returns the hostname or IP address of the machine that originated the message
    pub fn from(&self) -> Option<&Host<'x>> {
        self.from.as_ref()
    }

    /// Returns the IP address of the machine that originated the message
    pub fn from_ip(&self) -> Option<IpAddr> {
        self.from_ip
    }

    /// Returns the reverse DNS hostname of the machine that originated the message
    pub fn from_iprev(&self) -> Option<&str> {
        self.from_iprev.as_ref().map(|s| s.as_ref())
    }

    /// Returns the hostname or IP address of the machine that received the message
    pub fn by(&self) -> Option<&Host<'x>> {
        self.by.as_ref()
    }

    /// Returns the email address of the user that the message was received for
    pub fn for_(&self) -> Option<&str> {
        self.for_.as_ref().map(|s| s.as_ref())
    }

    /// Returns the protocol that was used to receive the message
    pub fn with(&self) -> Option<Protocol> {
        self.with
    }

    /// Returns the TLS version that was used to receive the message
    pub fn tls_version(&self) -> Option<TlsVersion> {
        self.tls_version
    }

    /// Returns the TLS cipher that was used to receive the message
    pub fn tls_cipher(&self) -> Option<&str> {
        self.tls_cipher.as_ref().map(|s| s.as_ref())
    }

    /// Returns the message ID of the message that was received
    pub fn id(&self) -> Option<&str> {
        self.id.as_ref().map(|s| s.as_ref())
    }

    /// Returns the identity of the user that sent the message
    pub fn ident(&self) -> Option<&str> {
        self.ident.as_ref().map(|s| s.as_ref())
    }

    /// Returns the EHLO/LHLO/HELO hostname or IP address of the machine that sent the message
    pub fn helo(&self) -> Option<&Host<'x>> {
        self.helo.as_ref()
    }

    /// Returns the EHLO/LHLO/HELO command that was sent by the client
    pub fn helo_cmd(&self) -> Option<Greeting> {
        self.helo_cmd
    }

    /// Returns the link type over which the message was received
    pub fn via(&self) -> Option<&str> {
        self.via.as_ref().map(|s| s.as_ref())
    }

    /// Returns the date and time when the message was received
    pub fn date(&self) -> Option<DateTime> {
        self.date
    }
}

/// A hostname or IP address.
impl Host<'_> {
    pub fn into_owned(self) -> Host<'static> {
        match self {
            Host::Name(name) => Host::Name(name.into_owned().into()),
            Host::IpAddr(ip) => Host::IpAddr(ip),
        }
    }
}

impl<'x> GetHeader<'x> for Vec<Header<'x>> {
    fn header_value(&self, name: &HeaderName<'_>) -> Option<&HeaderValue<'x>> {
        self.iter()
            .rev()
            .find(|header| &header.name == name)
            .map(|header| &header.value)
    }

    fn header(&self, name: impl Into<HeaderName<'x>>) -> Option<&Header<'x>> {
        let name = name.into();
        self.iter().rev().find(|header| header.name == name)
    }
}

impl<'x> From<&'x str> for HeaderName<'x> {
    fn from(value: &'x str) -> Self {
        HeaderName::parse(value).unwrap_or(HeaderName::Other("".into()))
    }
}

impl<'x> From<Cow<'x, str>> for HeaderName<'x> {
    fn from(value: Cow<'x, str>) -> Self {
        HeaderName::parse(value).unwrap_or(HeaderName::Other("".into()))
    }
}

impl From<String> for HeaderName<'_> {
    fn from(value: String) -> Self {
        HeaderName::parse(value).unwrap_or(HeaderName::Other("".into()))
    }
}

impl From<HeaderName<'_>> for String {
    fn from(header: HeaderName<'_>) -> Self {
        header.to_string()
    }
}

impl<'x> From<HeaderName<'x>> for Cow<'x, str> {
    fn from(header: HeaderName<'x>) -> Self {
        match header {
            HeaderName::Other(value) => value,
            _ => Cow::Borrowed(header.as_static_str()),
        }
    }
}

impl From<u8> for HeaderName<'_> {
    fn from(value: u8) -> Self {
        match value {
            0 => HeaderName::Subject,
            1 => HeaderName::From,
            2 => HeaderName::To,
            3 => HeaderName::Cc,
            4 => HeaderName::Date,
            5 => HeaderName::Bcc,
            6 => HeaderName::ReplyTo,
            7 => HeaderName::Sender,
            8 => HeaderName::Comments,
            9 => HeaderName::InReplyTo,
            10 => HeaderName::Keywords,
            11 => HeaderName::Received,
            12 => HeaderName::MessageId,
            13 => HeaderName::References,
            14 => HeaderName::ReturnPath,
            15 => HeaderName::MimeVersion,
            16 => HeaderName::ContentDescription,
            17 => HeaderName::ContentId,
            18 => HeaderName::ContentLanguage,
            19 => HeaderName::ContentLocation,
            20 => HeaderName::ContentTransferEncoding,
            21 => HeaderName::ContentType,
            22 => HeaderName::ContentDisposition,
            23 => HeaderName::ResentTo,
            24 => HeaderName::ResentFrom,
            25 => HeaderName::ResentBcc,
            26 => HeaderName::ResentCc,
            27 => HeaderName::ResentSender,
            28 => HeaderName::ResentDate,
            29 => HeaderName::ResentMessageId,
            30 => HeaderName::ListArchive,
            31 => HeaderName::ListHelp,
            32 => HeaderName::ListId,
            33 => HeaderName::ListOwner,
            34 => HeaderName::ListPost,
            35 => HeaderName::ListSubscribe,
            36 => HeaderName::ListUnsubscribe,
            38 => HeaderName::ArcAuthenticationResults,
            39 => HeaderName::ArcMessageSignature,
            40 => HeaderName::ArcSeal,
            41 => HeaderName::DkimSignature,
            _ => HeaderName::Other("".into()),
        }
    }
}

impl From<DateTime> for i64 {
    fn from(value: DateTime) -> Self {
        value.to_timestamp()
    }
}

impl TlsVersion {
    pub fn as_str(&self) -> &'static str {
        match self {
            TlsVersion::SSLv2 => "SSLv2",
            TlsVersion::SSLv3 => "SSLv3",
            TlsVersion::TLSv1_0 => "TLSv1.0",
            TlsVersion::TLSv1_1 => "TLSv1.1",
            TlsVersion::TLSv1_2 => "TLSv1.2",
            TlsVersion::TLSv1_3 => "TLSv1.3",
            TlsVersion::DTLSv1_0 => "DTLSv1.0",
            TlsVersion::DTLSv1_2 => "DTLSv1.2",
            TlsVersion::DTLSv1_3 => "DTLSv1.3",
        }
    }
}

impl Greeting {
    pub fn as_str(&self) -> &'static str {
        match self {
            Greeting::Helo => "HELO",
            Greeting::Ehlo => "EHLO",
            Greeting::Lhlo => "LHLO",
        }
    }
}

impl Protocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Protocol::SMTP => "SMTP",
            Protocol::LMTP => "LMTP",
            Protocol::ESMTP => "ESMTP",
            Protocol::ESMTPS => "ESMTPS",
            Protocol::ESMTPA => "ESMTPA",
            Protocol::ESMTPSA => "ESMTPSA",
            Protocol::LMTPA => "LMTPA",
            Protocol::LMTPS => "LMTPS",
            Protocol::LMTPSA => "LMTPSA",
            Protocol::UTF8SMTP => "UTF8SMTP",
            Protocol::UTF8SMTPA => "UTF8SMTPA",
            Protocol::UTF8SMTPS => "UTF8SMTPS",
            Protocol::UTF8SMTPSA => "UTF8SMTPSA",
            Protocol::UTF8LMTP => "UTF8LMTP",
            Protocol::UTF8LMTPA => "UTF8LMTPA",
            Protocol::UTF8LMTPS => "UTF8LMTPS",
            Protocol::UTF8LMTPSA => "UTF8LMTPSA",
            Protocol::HTTP => "HTTP",
            Protocol::HTTPS => "HTTPS",
            Protocol::IMAP => "IMAP",
            Protocol::POP3 => "POP3",
            Protocol::MMS => "MMS",
            Protocol::Local => "Local",
        }
    }
}

impl Display for Host<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Host::Name(name) => name.fmt(f),
            Host::IpAddr(ip) => ip.fmt(f),
        }
    }
}

impl Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Display for Greeting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Display for TlsVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Display for HeaderName<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}
