/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{
    Addr, Address, ArchivedAddr, ArchivedAddress, ArchivedContentType, ArchivedDateTime,
    ArchivedEncoding, ArchivedGreeting, ArchivedGroup, ArchivedHeader, ArchivedHeaderName,
    ArchivedHeaderValue, ArchivedHost, ArchivedProtocol, ArchivedReceived, ArchivedTlsVersion,
    Attribute, ContentType, DateTime, Greeting, Group, HeaderValue, Host, Protocol, Received,
    TlsVersion,
};
use rkyv::{string::ArchivedString, vec::ArchivedVec};
use std::fmt::Display;

pub trait ArchivedGetHeader<'x> {
    fn header_value(&self, name: &ArchivedHeaderName<'x>) -> Option<&ArchivedHeaderValue<'x>>;
    fn header(&self, name: impl Into<ArchivedHeaderName<'x>>) -> Option<&ArchivedHeader<'x>>;
}

impl<'x> ArchivedGetHeader<'x> for ArchivedVec<ArchivedHeader<'x>> {
    fn header_value(&self, name: &ArchivedHeaderName<'x>) -> Option<&ArchivedHeaderValue<'x>> {
        self.iter()
            .rev()
            .find(move |header| &header.name == name)
            .map(|header| &header.value)
    }

    fn header(&self, name: impl Into<ArchivedHeaderName<'x>>) -> Option<&ArchivedHeader<'x>> {
        let name = name.into();
        self.iter().rev().find(|header| header.name == name)
    }
}

impl ArchivedHeaderName<'_> {
    pub fn as_str(&self) -> &str {
        match self {
            ArchivedHeaderName::Other(other) => other.as_str(),
            _ => self.as_static_str(),
        }
    }

    pub fn is_mime_header(&self) -> bool {
        matches!(
            self,
            ArchivedHeaderName::ContentDescription
                | ArchivedHeaderName::ContentId
                | ArchivedHeaderName::ContentLanguage
                | ArchivedHeaderName::ContentLocation
                | ArchivedHeaderName::ContentTransferEncoding
                | ArchivedHeaderName::ContentType
                | ArchivedHeaderName::ContentDisposition
        )
    }
}

impl ArchivedEncoding {
    pub fn id(&self) -> u8 {
        match self {
            ArchivedEncoding::None => 0,
            ArchivedEncoding::QuotedPrintable => 1,
            ArchivedEncoding::Base64 => 2,
        }
    }
}

impl Display for ArchivedHeaderName<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl PartialEq for ArchivedHeaderName<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Other(a), Self::Other(b)) => a.eq_ignore_ascii_case(b),
            (Self::Other(_), _) | (_, Self::Other(_)) => false,
            _ => self.id() == other.id(),
        }
    }
}

impl std::hash::Hash for ArchivedHeaderName<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match self {
            ArchivedHeaderName::Other(value) => {
                for ch in value.as_bytes() {
                    ch.to_ascii_lowercase().hash(state)
                }
            }
            _ => self.id().hash(state),
        }
    }
}

impl Eq for ArchivedHeaderName<'_> {}

impl From<&ArchivedHeaderValue<'_>> for HeaderValue<'static> {
    fn from(value: &ArchivedHeaderValue<'_>) -> Self {
        match value {
            ArchivedHeaderValue::Text(s) => HeaderValue::Text(s.to_string().into()),
            ArchivedHeaderValue::TextList(list) => {
                HeaderValue::TextList(list.iter().map(|s| s.to_string().into()).collect())
            }
            ArchivedHeaderValue::DateTime(d) => HeaderValue::DateTime(d.into()),
            ArchivedHeaderValue::ContentType(ct) => HeaderValue::ContentType(ct.into()),
            ArchivedHeaderValue::Empty => HeaderValue::Empty,
            ArchivedHeaderValue::Address(a) => HeaderValue::Address(a.into()),
            ArchivedHeaderValue::Received(r) => HeaderValue::Received(Box::new(r.as_ref().into())),
        }
    }
}

impl From<&ArchivedAddress<'_>> for Address<'static> {
    fn from(value: &ArchivedAddress<'_>) -> Self {
        match value {
            ArchivedAddress::List(list) => Address::List(list.iter().map(Into::into).collect()),
            ArchivedAddress::Group(groups) => {
                Address::Group(groups.iter().map(Into::into).collect())
            }
        }
    }
}

impl From<&ArchivedContentType<'_>> for ContentType<'static> {
    fn from(value: &ArchivedContentType<'_>) -> Self {
        ContentType {
            c_type: value.c_type.to_string().into(),
            c_subtype: value.subtype().map(|s| s.to_string().into()),
            attributes: value.attributes.as_ref().map(|attrs| {
                attrs
                    .iter()
                    .map(|a| Attribute {
                        name: a.name.to_string().into(),
                        value: a.value.to_string().into(),
                    })
                    .collect()
            }),
        }
    }
}

impl From<&ArchivedGroup<'_>> for Group<'static> {
    fn from(value: &ArchivedGroup<'_>) -> Self {
        Group {
            name: value.name.as_ref().map(|s| s.to_string().into()),
            addresses: value.addresses.iter().map(|a| a.into()).collect(),
        }
    }
}

impl From<&ArchivedAddr<'_>> for Addr<'static> {
    fn from(value: &ArchivedAddr<'_>) -> Self {
        Addr {
            name: value.name().map(|s| s.to_string().into()),
            address: value.address().map(|s| s.to_string().into()),
        }
    }
}

impl From<&ArchivedDateTime> for DateTime {
    fn from(value: &ArchivedDateTime) -> Self {
        DateTime {
            year: value.year.to_native(),
            month: value.month,
            day: value.day,
            hour: value.hour,
            minute: value.minute,
            second: value.second,
            tz_before_gmt: value.tz_before_gmt,
            tz_hour: value.tz_hour,
            tz_minute: value.tz_minute,
        }
    }
}

impl From<&ArchivedReceived<'_>> for Received<'static> {
    fn from(value: &ArchivedReceived<'_>) -> Self {
        Received {
            from: value.from.as_ref().map(|s| s.into()),
            from_ip: value.from_ip.as_ref().map(|s| s.as_ipaddr()),
            from_iprev: value.from_iprev.as_ref().map(|s| s.to_string().into()),
            by: value.by.as_ref().map(|s| s.into()),
            for_: value.for_.as_ref().map(|s| s.to_string().into()),
            with: value.with.as_ref().map(|s| s.into()),
            tls_version: value.tls_version.as_ref().map(|s| s.into()),
            tls_cipher: value.tls_cipher.as_ref().map(|s| s.to_string().into()),
            id: value.id.as_ref().map(|s| s.to_string().into()),
            ident: value.ident.as_ref().map(|s| s.to_string().into()),
            helo: value.helo.as_ref().map(|s| s.into()),
            helo_cmd: value.helo_cmd.as_ref().map(|s| s.into()),
            via: value.via.as_ref().map(|s| s.to_string().into()),
            date: value.date.as_ref().map(|s| s.into()),
        }
    }
}

impl From<&ArchivedProtocol> for Protocol {
    fn from(value: &ArchivedProtocol) -> Self {
        match value {
            ArchivedProtocol::SMTP => Protocol::SMTP,
            ArchivedProtocol::ESMTP => Protocol::ESMTP,
            ArchivedProtocol::ESMTPA => Protocol::ESMTPA,
            ArchivedProtocol::ESMTPS => Protocol::ESMTPS,
            ArchivedProtocol::ESMTPSA => Protocol::ESMTPSA,
            ArchivedProtocol::LMTP => Protocol::LMTP,
            ArchivedProtocol::LMTPA => Protocol::LMTPA,
            ArchivedProtocol::LMTPS => Protocol::LMTPS,
            ArchivedProtocol::LMTPSA => Protocol::LMTPSA,
            ArchivedProtocol::MMS => Protocol::MMS,
            ArchivedProtocol::UTF8SMTP => Protocol::UTF8SMTP,
            ArchivedProtocol::UTF8SMTPA => Protocol::UTF8SMTPA,
            ArchivedProtocol::UTF8SMTPS => Protocol::UTF8SMTPS,
            ArchivedProtocol::UTF8SMTPSA => Protocol::UTF8SMTPSA,
            ArchivedProtocol::UTF8LMTP => Protocol::UTF8LMTP,
            ArchivedProtocol::UTF8LMTPA => Protocol::UTF8LMTPA,
            ArchivedProtocol::UTF8LMTPS => Protocol::UTF8LMTPS,
            ArchivedProtocol::UTF8LMTPSA => Protocol::UTF8LMTPSA,
            ArchivedProtocol::HTTP => Protocol::HTTP,
            ArchivedProtocol::HTTPS => Protocol::HTTPS,
            ArchivedProtocol::IMAP => Protocol::IMAP,
            ArchivedProtocol::POP3 => Protocol::POP3,
            ArchivedProtocol::Local => Protocol::Local,
        }
    }
}

impl From<&ArchivedGreeting> for Greeting {
    fn from(value: &ArchivedGreeting) -> Self {
        match value {
            ArchivedGreeting::Helo => Greeting::Helo,
            ArchivedGreeting::Ehlo => Greeting::Ehlo,
            ArchivedGreeting::Lhlo => Greeting::Lhlo,
        }
    }
}

impl From<&ArchivedTlsVersion> for TlsVersion {
    fn from(value: &ArchivedTlsVersion) -> Self {
        match value {
            ArchivedTlsVersion::SSLv2 => TlsVersion::SSLv2,
            ArchivedTlsVersion::SSLv3 => TlsVersion::SSLv3,
            ArchivedTlsVersion::TLSv1_0 => TlsVersion::TLSv1_0,
            ArchivedTlsVersion::TLSv1_1 => TlsVersion::TLSv1_1,
            ArchivedTlsVersion::TLSv1_2 => TlsVersion::TLSv1_2,
            ArchivedTlsVersion::TLSv1_3 => TlsVersion::TLSv1_3,
            ArchivedTlsVersion::DTLSv1_0 => TlsVersion::DTLSv1_0,
            ArchivedTlsVersion::DTLSv1_2 => TlsVersion::DTLSv1_2,
            ArchivedTlsVersion::DTLSv1_3 => TlsVersion::DTLSv1_3,
        }
    }
}

impl From<&ArchivedHost<'_>> for Host<'static> {
    fn from(value: &ArchivedHost<'_>) -> Self {
        match value {
            ArchivedHost::Name(name) => Host::Name(name.to_string().into()),
            ArchivedHost::IpAddr(ip) => Host::IpAddr(ip.as_ipaddr()),
        }
    }
}

impl<'x> ArchivedAddress<'x> {
    pub fn iter(
        &self,
    ) -> Box<dyn DoubleEndedIterator<Item = &ArchivedAddr<'x>> + '_ + Sync + Send> {
        match self {
            ArchivedAddress::List(list) => Box::new(list.iter()),
            ArchivedAddress::Group(group) => {
                Box::new(group.iter().flat_map(|group| group.addresses.iter()))
            }
        }
    }
}

impl ArchivedAddr<'_> {
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn address(&self) -> Option<&str> {
        self.address.as_deref()
    }
}

impl ArchivedContentType<'_> {
    pub fn ctype(&self) -> &str {
        &self.c_type
    }

    pub fn subtype(&self) -> Option<&str> {
        self.c_subtype.as_deref()
    }

    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .as_ref()?
            .iter()
            .find(|k| k.name == name)?
            .value
            .as_ref()
            .into()
    }
}

impl<'x> ArchivedHeaderValue<'x> {
    pub fn as_text(&self) -> Option<&str> {
        match *self {
            ArchivedHeaderValue::Text(ref s) => Some(s),
            ArchivedHeaderValue::TextList(ref l) => l.last().map(|s| s.as_str()),
            _ => None,
        }
    }

    pub fn as_content_type(&self) -> Option<&ArchivedContentType<'x>> {
        match self {
            ArchivedHeaderValue::ContentType(c) => Some(c),
            _ => None,
        }
    }

    pub fn as_text_list(&self) -> Option<&[ArchivedString]> {
        match *self {
            ArchivedHeaderValue::Text(ref s) => Some(std::slice::from_ref(s)),
            ArchivedHeaderValue::TextList(ref l) => Some(l.as_slice()),
            _ => None,
        }
    }

    pub fn as_datetime(&self) -> Option<&ArchivedDateTime> {
        match self {
            ArchivedHeaderValue::DateTime(d) => Some(d),
            _ => None,
        }
    }
}
