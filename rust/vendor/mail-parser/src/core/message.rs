/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::{borrow::Cow, convert::TryInto};

use crate::{
    Address, AttachmentIterator, BodyPartIterator, DateTime, GetHeader, Header, HeaderForm,
    HeaderName, HeaderValue, Message, MessageParser, MessagePart, PartType, Received,
    decoders::html::{html_to_text, text_to_html},
    parsers::{
        MessageStream,
        fields::thread::thread_name,
        preview::{preview_html, preview_text},
    },
};

impl<'x> Message<'x> {
    /// Returns the root message part
    pub fn root_part(&self) -> &MessagePart<'x> {
        &self.parts[0]
    }

    /// Returns a parsed header.
    pub fn header(&self, header: impl Into<HeaderName<'x>>) -> Option<&HeaderValue<'x>> {
        self.parts[0].headers.header(header).map(|h| &h.value)
    }

    /// Removed a parsed header and returns its value.
    pub fn remove_header(&mut self, header: impl Into<HeaderName<'x>>) -> Option<HeaderValue<'x>> {
        let header = header.into();
        let headers = &mut self.parts[0].headers;
        headers
            .iter()
            .position(|h| h.name == header)
            .map(|pos| headers.swap_remove(pos).value)
    }

    /// Returns the raw header.
    pub fn header_raw(&self, header: impl Into<HeaderName<'x>>) -> Option<&str> {
        self.parts[0].headers.header(header).and_then(|h| {
            std::str::from_utf8(&self.raw_message[h.offset_start as usize..h.offset_end as usize])
                .ok()
        })
    }

    // Parse a header as a specific type.
    pub fn header_as(
        &self,
        header: impl Into<HeaderName<'x>>,
        form: HeaderForm,
    ) -> Vec<HeaderValue<'_>> {
        let header = header.into();
        let mut results = Vec::new();
        for header_ in &self.parts[0].headers {
            if header_.name == header {
                results.push(
                    self.raw_message
                        .get(header_.offset_start as usize..header_.offset_end as usize)
                        .map_or(HeaderValue::Empty, |bytes| match form {
                            HeaderForm::Raw => HeaderValue::Text(
                                std::str::from_utf8(bytes).unwrap_or_default().trim().into(),
                            ),
                            HeaderForm::Text => MessageStream::new(bytes).parse_unstructured(),
                            HeaderForm::Addresses => MessageStream::new(bytes).parse_address(),
                            HeaderForm::GroupedAddresses => {
                                MessageStream::new(bytes).parse_address()
                            }
                            HeaderForm::MessageIds => MessageStream::new(bytes).parse_id(),
                            HeaderForm::Date => MessageStream::new(bytes).parse_date(),
                            HeaderForm::URLs => MessageStream::new(bytes).parse_address(),
                        }),
                );
            }
        }

        results
    }

    /// Returns an iterator over the RFC headers of this message.
    pub fn headers(&self) -> &[Header<'x>] {
        &self.parts[0].headers
    }

    /// Returns an iterator over the matching RFC headers of this message.
    pub fn header_values(
        &self,
        name: impl Into<HeaderName<'x>>,
    ) -> impl Iterator<Item = &HeaderValue<'x>> + Sync + Send {
        let name = name.into();
        self.parts[0].headers.iter().filter_map(move |header| {
            if header.name == name {
                Some(&header.value)
            } else {
                None
            }
        })
    }

    /// Returns all headers in raw format
    pub fn headers_raw(&self) -> impl Iterator<Item = (&str, &str)> + Sync + Send {
        self.parts[0].headers.iter().filter_map(move |header| {
            Some((
                header.name.as_str(),
                std::str::from_utf8(
                    &self.raw_message[header.offset_start as usize..header.offset_end as usize],
                )
                .ok()?,
            ))
        })
    }

    /// Returns the raw message
    pub fn raw_message(&self) -> &[u8] {
        let part = &self.parts[0];
        self.raw_message
            .get(part.offset_header as usize..part.offset_end as usize)
            .unwrap_or_default()
    }

    /// Returns the BCC header field
    pub fn bcc(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Bcc)
            .and_then(|a| a.as_address())
    }

    /// Returns all BCC header fields, permitted by [4.5.3 Obsolete Destination Address Fields](https://www.rfc-editor.org/info/rfc5322/#section-4.5.3)
    pub fn all_bcc(&self) -> impl Iterator<Item = &Address<'x>> {
        self.header_values(HeaderName::Bcc)
            .filter_map(|a| a.as_address())
    }

    /// Returns the CC header field
    pub fn cc(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Cc)
            .and_then(|a| a.as_address())
    }

    /// Returns all CC header fields, permitted by [4.5.3 Obsolete Destination Address Fields](https://www.rfc-editor.org/info/rfc5322/#section-4.5.3)
    pub fn all_cc(&self) -> impl Iterator<Item = &Address<'x>> {
        self.header_values(HeaderName::Cc)
            .filter_map(|a| a.as_address())
    }

    /// Returns all Comments header fields
    pub fn comments(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Comments)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the Date header field
    pub fn date(&self) -> Option<&DateTime> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Date)
            .and_then(|header| header.as_datetime())
    }

    /// Returns the From header field
    pub fn from(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::From)
            .and_then(|a| a.as_address())
    }

    /// Returns all In-Reply-To header fields
    pub fn in_reply_to(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::InReplyTo)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns all Keywords header fields
    pub fn keywords(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Keywords)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-Archive header field
    pub fn list_archive(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListArchive)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-Help header field
    pub fn list_help(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListHelp)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-ID header field
    pub fn list_id(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListId)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-Owner header field
    pub fn list_owner(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListOwner)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-Post header field
    pub fn list_post(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListPost)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-Subscribe header field
    pub fn list_subscribe(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListSubscribe)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the List-Unsubscribe header field
    pub fn list_unsubscribe(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ListUnsubscribe)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the Message-ID header field
    pub fn message_id(&self) -> Option<&str> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::MessageId)
            .and_then(|header| header.as_text())
    }

    /// Returns the MIME-Version header field
    pub fn mime_version(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::MimeVersion)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the last Received header field
    pub fn received(&self) -> Option<&Received<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Received)
            .and_then(|header| header.as_received())
    }

    /// Returns an iterator over all Received header fields, in the order they
    /// appear in the message.
    pub fn received_all(&self) -> impl Iterator<Item = &Received<'x>> + Sync + Send {
        self.header_values(HeaderName::Received)
            .filter_map(|header| header.as_received())
    }

    /// Returns all References header fields
    pub fn references(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::References)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the Reply-To header field
    pub fn reply_to(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ReplyTo)
            .and_then(|a| a.as_address())
    }

    /// Returns the Resent-BCC header field
    pub fn resent_bcc(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentBcc)
            .and_then(|a| a.as_address())
    }

    /// Returns the Resent-CC header field
    pub fn resent_cc(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentTo)
            .and_then(|a| a.as_address())
    }

    /// Returns all Resent-Date header fields
    pub fn resent_date(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentDate)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the Resent-From header field
    pub fn resent_from(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentFrom)
            .and_then(|a| a.as_address())
    }

    /// Returns all Resent-Message-ID header fields
    pub fn resent_message_id(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentMessageId)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the Sender header field
    pub fn resent_sender(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentSender)
            .and_then(|a| a.as_address())
    }

    /// Returns the Resent-To header field
    pub fn resent_to(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ResentTo)
            .and_then(|a| a.as_address())
    }

    /// Returns all Return-Path header fields
    pub fn return_path(&self) -> &HeaderValue<'x> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::ReturnPath)
            .unwrap_or(&HeaderValue::Empty)
    }

    /// Returns the return address from either the Return-Path
    /// or From header fields
    pub fn return_address(&self) -> Option<&str> {
        match self.parts[0].headers.header_value(&HeaderName::ReturnPath) {
            Some(HeaderValue::Text(text)) => Some(text.as_ref()),
            Some(HeaderValue::TextList(text_list)) => text_list.last().map(|t| t.as_ref()),
            _ => match self.parts[0].headers.header_value(&HeaderName::From) {
                Some(HeaderValue::Address(addr)) => addr.first()?.address.as_deref(),
                _ => None,
            },
        }
    }

    /// Returns the Sender header field
    pub fn sender(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Sender)
            .and_then(|a| a.as_address())
    }

    /// Returns the Subject header field
    pub fn subject(&self) -> Option<&str> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::Subject)
            .and_then(|header| header.as_text())
    }

    /// Returns the message thread name or 'base subject' as defined in
    /// [RFC 5957 - Internet Message Access Protocol - SORT and THREAD Extensions (Section 2.1)](https://datatracker.ietf.org/doc/html/rfc5256#section-2.1)
    pub fn thread_name(&self) -> Option<&str> {
        thread_name(self.subject()?).into()
    }

    /// Returns the To header field
    pub fn to(&self) -> Option<&Address<'x>> {
        self.parts[0]
            .headers
            .header_value(&HeaderName::To)
            .and_then(|a| a.as_address())
    }

    /// Returns all To header fields, permitted by [4.5.3 Obsolete Destination Address Fields](https://www.rfc-editor.org/info/rfc5322/#section-4.5.3)
    pub fn all_to(&self) -> impl Iterator<Item = &Address<'x>> {
        self.header_values(HeaderName::To)
            .filter_map(|a| a.as_address())
    }

    /// Returns a preview of the message body
    pub fn body_preview(&self, preview_len: usize) -> Option<Cow<'x, str>> {
        if !self.text_body.is_empty() {
            preview_text(self.body_text(0)?, preview_len).into()
        } else if !self.html_body.is_empty() {
            preview_html(self.body_html(0)?, preview_len).into()
        } else {
            None
        }
    }

    /// Returns a message body part as text/plain
    pub fn body_html(&'x self, pos: usize) -> Option<Cow<'x, str>> {
        let part = self.parts.get(*self.html_body.get(pos)? as usize)?;
        match &part.body {
            PartType::Html(html) => Some(html.as_ref().into()),
            PartType::Text(text) => Some(text_to_html(text.as_ref()).into()),
            _ => None,
        }
    }

    /// Returns a message body part as text/plain
    pub fn body_text(&'x self, pos: usize) -> Option<Cow<'x, str>> {
        let part = self.parts.get(*self.text_body.get(pos)? as usize)?;
        match &part.body {
            PartType::Text(text) => Some(text.as_ref().into()),
            PartType::Html(html) => Some(html_to_text(html.as_ref()).into()),
            _ => None,
        }
    }

    /// Returns a message part by position
    pub fn part(&self, pos: u32) -> Option<&MessagePart<'x>> {
        self.parts.get(pos as usize)
    }

    /// Returns an inline HTML body part by position
    pub fn html_part(&self, pos: u32) -> Option<&MessagePart<'x>> {
        self.parts.get(*self.html_body.get(pos as usize)? as usize)
    }

    /// Returns an inline text body part by position
    pub fn text_part(&self, pos: u32) -> Option<&MessagePart<'x>> {
        self.parts.get(*self.text_body.get(pos as usize)? as usize)
    }

    /// Returns an attacment by position
    pub fn attachment(&self, pos: u32) -> Option<&MessagePart<'x>> {
        self.parts
            .get(*self.attachments.get(pos as usize)? as usize)
    }

    /// Returns the number of plain text body parts
    pub fn text_body_count(&self) -> usize {
        self.text_body.len()
    }

    /// Returns the number of HTML body parts
    pub fn html_body_count(&self) -> usize {
        self.html_body.len()
    }

    /// Returns the number of attachments
    pub fn attachment_count(&self) -> usize {
        self.attachments.len()
    }

    /// Returns an Interator over the text body parts
    pub fn text_bodies(&self) -> impl Iterator<Item = &'_ MessagePart<'_>> + Sync + Send {
        BodyPartIterator::new(self, &self.text_body)
    }

    /// Returns an Interator over the HTML body parts
    pub fn html_bodies(&self) -> impl Iterator<Item = &'_ MessagePart<'_>> + Sync + Send {
        BodyPartIterator::new(self, &self.html_body)
    }

    /// Returns an Interator over the attachments
    pub fn attachments(&self) -> impl Iterator<Item = &'_ MessagePart<'_>> + Sync + Send {
        AttachmentIterator::new(self)
    }

    /// Returns an owned version of the message
    pub fn into_owned(self) -> Message<'static> {
        Message {
            html_body: self.html_body,
            text_body: self.text_body,
            attachments: self.attachments,
            parts: self.parts.into_iter().map(|p| p.into_owned()).collect(),
            raw_message: self.raw_message.into_owned().into(),
        }
    }
}

impl<'x> TryInto<Message<'x>> for &'x [u8] {
    type Error = ();

    fn try_into(self) -> Result<Message<'x>, Self::Error> {
        MessageParser::default().parse(self).ok_or(())
    }
}
