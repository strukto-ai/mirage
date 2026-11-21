/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{HeaderName, HeaderValue, MessageParser};

impl MessageParser {
    /// Create a new builder for a message parser using the default settings.
    ///
    /// The default settings are:
    ///
    /// * IANA-registered headers defined in `HeaderName` are parsed with their corresponding parser.
    /// * Other headers (`HeaderName::Other`) are parsed as raw.
    ///
    pub fn new() -> Self {
        Self {
            header_map: Default::default(),
            def_hdr_parse_fnc: |s| s.parse_raw(),
        }
    }

    /// Parse all MIME headers:
    ///
    /// * `Content-Type`
    /// * `Content-Disposition`
    /// * `Content-Id`
    /// * `Content-Description`
    /// * `Content-Location`
    /// * `Content-Transfer-Encoding`
    ///
    /// Adding these MIME headers is required in order to parse message bodies.
    ///
    pub fn with_mime_headers(self) -> Self {
        self.header_content_type(HeaderName::ContentType)
            .header_content_type(HeaderName::ContentDisposition)
            .header_id(HeaderName::ContentId)
            .header_text(HeaderName::ContentDescription)
            .header_text(HeaderName::ContentLocation)
            .header_text(HeaderName::ContentTransferEncoding)
    }

    /// Parse all Date headers:
    ///
    /// * `Date`
    /// * `Resent-Date`
    ///
    pub fn with_date_headers(self) -> Self {
        self.header_date(HeaderName::Date)
            .header_date(HeaderName::ResentDate)
    }

    /// Parse all address headers:
    ///
    /// * `From`
    /// * `Sender`
    /// * `Reply-To`
    /// * `To`
    /// * `Cc`
    /// * `Bcc`
    /// * `Resent-From`
    /// * `Resent-Sender`
    /// * `Resent-To`
    /// * `Resent-Cc`
    /// * `Resent-Bcc`
    ///
    pub fn with_address_headers(self) -> Self {
        self.header_address(HeaderName::From)
            .header_address(HeaderName::Sender)
            .header_address(HeaderName::ReplyTo)
            .header_address(HeaderName::To)
            .header_address(HeaderName::Cc)
            .header_address(HeaderName::Bcc)
            .header_address(HeaderName::ResentFrom)
            .header_address(HeaderName::ResentSender)
            .header_address(HeaderName::ResentTo)
            .header_address(HeaderName::ResentCc)
            .header_address(HeaderName::ResentBcc)
    }

    /// Parse all ID headers:
    ///
    /// * `Message-Id`
    /// * `In-Reply-To`
    /// * `References`
    /// * `Resent-Message-Id`
    ///
    pub fn with_message_ids(self) -> Self {
        self.header_id(HeaderName::MessageId)
            .header_id(HeaderName::InReplyTo)
            .header_id(HeaderName::References)
            .header_id(HeaderName::ResentMessageId)
    }

    /// Parse all MIME headers plus:
    ///
    /// * `Date`
    /// * `From`
    /// * `Reply-To`
    /// * `To`
    /// * `Cc`
    /// * `Bcc`
    ///
    pub fn with_minimal_headers(self) -> Self {
        self.with_mime_headers()
            .header_date(HeaderName::Date)
            .header_text(HeaderName::Subject)
            .header_address(HeaderName::From)
            .header_address(HeaderName::ReplyTo)
            .header_address(HeaderName::To)
            .header_address(HeaderName::Cc)
            .header_address(HeaderName::Bcc)
    }

    /// Remove a custom header parser.
    pub fn without_header(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map.remove(&header.into());
        self
    }

    /// Parse a header as text decoding RFC 2047 encoded words.
    pub fn header_text(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map
            .insert(header.into(), |s| s.parse_unstructured());
        self
    }

    /// Parse a header as a RFC 5322 date.
    pub fn header_date(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map.insert(header.into(), |s| s.parse_date());
        self
    }

    /// Parse a header as an address.
    pub fn header_address(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map.insert(header.into(), |s| s.parse_address());
        self
    }

    /// Parse a header as an ID.
    pub fn header_id(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map.insert(header.into(), |s| s.parse_id());
        self
    }

    /// Parse a header as a MIME `Content-Type` or `Content-Disposition` type.
    pub fn header_content_type(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map
            .insert(header.into(), |s| s.parse_content_type());
        self
    }

    /// Parse a header as a comma-separated list of values.
    pub fn header_comma_separated(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map
            .insert(header.into(), |s| s.parse_comma_separared());
        self
    }

    /// Parse a header as a received header.
    pub fn header_received(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map
            .insert(header.into(), |s| s.parse_received());
        self
    }

    /// Parse a header as a raw string, no RFC 2047 decoding is done.
    pub fn header_raw(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map.insert(header.into(), |s| s.parse_raw());
        self
    }

    /// Ignore and skip parsing a header.
    pub fn ignore_header(mut self, header: impl Into<HeaderName<'static>>) -> Self {
        self.header_map.insert(header.into(), |s| {
            s.parse_and_ignore();
            HeaderValue::Empty
        });
        self
    }

    /// Parse all other headers as text decoding RFC 2047 encoded words.
    pub fn default_header_text(mut self) -> Self {
        self.def_hdr_parse_fnc = |s| s.parse_unstructured();
        self
    }

    /// Parse all other headers as raw strings, no RFC 2047 decoding is done.
    pub fn default_header_raw(mut self) -> Self {
        self.def_hdr_parse_fnc = |s| s.parse_raw();
        self
    }

    /// Ignore and skip parsing all other headers.
    pub fn default_header_ignore(mut self) -> Self {
        self.def_hdr_parse_fnc = |s| {
            s.parse_and_ignore();
            HeaderValue::Empty
        };
        self
    }
}

impl Default for MessageParser {
    fn default() -> Self {
        Self::new()
    }
}
