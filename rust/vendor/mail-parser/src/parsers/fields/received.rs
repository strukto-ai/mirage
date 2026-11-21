/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{
    DateTime, Greeting, HeaderValue, Host, Protocol, Received, TlsVersion, parsers::MessageStream,
};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    BracketOpen,
    BracketClose,
    AngleOpen,
    AngleClose,
    ParenthesisOpen,
    ParenthesisClose,
    Semicolon,
    Colon,
    Equal,
    Slash,
    Quote,
    Comma,
    IpAddr(IpAddr),
    Integer(i64),
    Text,
    Domain,
    Email,
    Month(Month),
    Protocol(Protocol),
    Greeting(Greeting),
    TlsVersion(TlsVersion),
    Cipher,
    By,
    For,
    From,
    Id,
    Via,
    With,
    Ident,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TokenData<'x> {
    token: Token,
    text: &'x str,
    comment_depth: u32,
    bracket_depth: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Month {
    Jan,
    Feb,
    Mar,
    Apr,
    May,
    Jun,
    Jul,
    Aug,
    Sep,
    Oct,
    Nov,
    Dec,
}

struct Tokenizer<'x, 'y> {
    stream: &'y mut MessageStream<'x>,
    next_token: Option<TokenData<'x>>,
    eof: bool,
    in_quote: bool,
    bracket_depth: u32,
    comment_depth: u32,
    in_date: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    From,
    By,
    For,
    Id,
    With,
    Via,
    Date,
    None,
}

impl<'x> MessageStream<'x> {
    pub fn parse_received(&mut self) -> HeaderValue<'x> {
        //let c = print!("-> {}", std::str::from_utf8(self.data).unwrap());

        let mut tokenizer = Tokenizer::new(self).peekable();
        let mut received = Received::default();

        let mut state = State::None;
        let mut date = [i64::MAX; 7];
        let mut date_part = date.iter_mut();

        while let Some(token) = tokenizer.next() {
            match token.token {
                Token::From if received.from.is_none() => {
                    // Try obtaining hostname
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::BracketOpen => {
                                tokenizer.next();
                            }
                            Token::IpAddr(ip) => {
                                tokenizer.next();
                                received.from = Some(Host::IpAddr(ip));
                                break;
                            }
                            _ => {
                                if !token.token.is_separator() {
                                    received.from =
                                        Some(Host::Name(tokenizer.next().unwrap().text.into()));
                                }
                                break;
                            }
                        }
                    }
                    state = State::From;
                }
                Token::By if token.comment_depth == 0 => {
                    // Try obtaining hostname
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::BracketOpen | Token::AngleOpen => {
                                tokenizer.next();
                            }
                            Token::IpAddr(ip) => {
                                tokenizer.next();
                                received.by = Some(Host::IpAddr(ip));
                                break;
                            }
                            _ => {
                                if !token.token.is_separator() {
                                    received.by =
                                        Some(Host::Name(tokenizer.next().unwrap().text.into()));
                                }
                                break;
                            }
                        }
                    }
                    state = State::By;
                }
                Token::For if token.comment_depth == 0 => {
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::Equal | Token::AngleOpen => {
                                tokenizer.next();
                            }
                            Token::Email => {
                                received.for_ = Some(tokenizer.next().unwrap().text.into());
                                break;
                            }
                            _ => {
                                break;
                            }
                        }
                    }
                    state = State::For;
                }
                Token::Semicolon if token.comment_depth == 0 => {
                    state = State::Date;
                }
                Token::Id if token.comment_depth == 0 => {
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::Equal | Token::AngleOpen | Token::BracketOpen | Token::Colon => {
                                tokenizer.next();
                            }
                            _ => {
                                if !token.token.is_separator() {
                                    received.id = Some(tokenizer.next().unwrap().text.into());
                                }
                                break;
                            }
                        }
                    }
                    state = State::Id;
                }
                Token::With if token.comment_depth == 0 => {
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::Protocol(proto) => {
                                tokenizer.next();
                                received.with = Some(proto);
                                break;
                            }
                            Token::Semicolon
                            | Token::TlsVersion(_)
                            | Token::By
                            | Token::For
                            | Token::From
                            | Token::Id
                            | Token::Via
                            | Token::With => {
                                break;
                            }
                            _ => {
                                tokenizer.next();
                            }
                        }
                    }
                    state = State::With;
                }
                Token::Via if token.comment_depth == 0 => {
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::Equal => {
                                tokenizer.next();
                            }
                            _ => {
                                if !token.token.is_separator() {
                                    received.via = Some(tokenizer.next().unwrap().text.into());
                                }
                                break;
                            }
                        }
                    }
                    state = State::Via;
                }
                Token::Ident if token.comment_depth > 0 => {
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::Equal | Token::AngleOpen | Token::BracketOpen | Token::Colon => {
                                tokenizer.next();
                            }
                            _ => {
                                if !token.token.is_separator() {
                                    received.ident = Some(tokenizer.next().unwrap().text.into());
                                }
                                break;
                            }
                        }
                    }
                }
                Token::Greeting(greeting) if state == State::From && token.comment_depth > 0 => {
                    // Try obtaining hostname
                    received.helo_cmd = Some(greeting);
                    while let Some(token) = tokenizer.peek() {
                        match token.token {
                            Token::Equal | Token::BracketOpen | Token::Colon => {
                                tokenizer.next();
                            }
                            Token::IpAddr(ip) => {
                                tokenizer.next();
                                received.helo = Some(Host::IpAddr(ip));
                                break;
                            }
                            _ => {
                                if !token.token.is_separator() {
                                    received.helo =
                                        Some(Host::Name(tokenizer.next().unwrap().text.into()));
                                }
                                break;
                            }
                        }
                    }
                }
                Token::IpAddr(ip)
                    if state == State::From
                        && (token.bracket_depth > 0
                            || (token.comment_depth > 0 && received.from_ip.is_none())) =>
                {
                    received.from_ip = Some(ip);
                }
                Token::Domain if state == State::From && token.comment_depth > 0 => {
                    received.from_iprev = Some(token.text.into());
                }
                Token::Email if state == State::From => {
                    received.ident =
                        Some(token.text.strip_suffix('@').unwrap_or(token.text).into());
                }
                Token::Integer(num) if state == State::Date => {
                    if let Some(part) = date_part.next() {
                        *part = num;
                    }
                }
                Token::Month(month) if state == State::Date => {
                    if let Some(part) = date_part.next() {
                        *part = month.to_number();
                    }
                }
                Token::Cipher if token.comment_depth > 0 || received.tls_cipher.is_none() => {
                    received.tls_cipher = Some(token.text.into());
                }
                Token::TlsVersion(tls)
                    if token.comment_depth > 0 && received.tls_version.is_none() =>
                {
                    received.tls_version = Some(tls);
                }
                _ => (),
            }
        }

        if date[5] != i64::MAX {
            let (tz, is_plus) = if date[6] != i64::MAX {
                if date[6] < 0 {
                    (date[6].abs(), false)
                } else {
                    (date[6], true)
                }
            } else {
                (0, false)
            };
            received.date = DateTime {
                year: if (1..=99).contains(&date[2]) {
                    date[2] + 1900
                } else {
                    date[2]
                } as u16,
                month: date[1] as u8,
                day: date[0] as u8,
                hour: date[3] as u8,
                minute: date[4] as u8,
                second: date[5] as u8,
                tz_hour: (tz / 100) as u8,
                tz_minute: (tz % 100) as u8,
                tz_before_gmt: !is_plus,
            }
            .into();
        }

        if received.from.is_some()
            || received.from_ip.is_some()
            || received.from_iprev.is_some()
            || received.by.is_some()
            || received.for_.is_some()
            || received.with.is_some()
            || received.tls_version.is_some()
            || received.tls_cipher.is_some()
            || received.id.is_some()
            || received.ident.is_some()
            || received.helo.is_some()
            || received.helo_cmd.is_some()
            || received.via.is_some()
            || received.date.is_some()
        {
            HeaderValue::Received(Box::new(received))
        } else {
            HeaderValue::Empty
        }
    }
}

impl<'x> Iterator for Tokenizer<'x, '_> {
    type Item = TokenData<'x>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(next_token) = self.next_token.take() {
            return Some(next_token);
        } else if self.eof {
            return None;
        }
        let mut n_alpha = 0; // 1
        let mut n_digit = 0; // 2
        let mut n_hex = 0; // 3
        let mut n_dot = 0; // 4
        let mut n_at = 0; // 5
        let mut n_other = 0; // 6
        let mut n_colon = 0; // 7
        let mut n_plus = 0; // 8
        let mut n_minus = 0; // 9
        let mut n_utf = 0; // 10
        let mut n_uppercase = 0;
        let mut n_underscore = 0;

        let mut n_total = 0;

        let mut hash: u128 = 0;
        let mut hash_shift = 0;

        let comment_depth = self.comment_depth;
        let bracket_depth = self.bracket_depth;

        let mut start_pos = self.stream.offset();
        let mut end_pos = start_pos;

        while let Some(ch) = self.stream.next() {
            match ch {
                b'0'..=b'9' => {
                    n_digit += 1;
                    if hash_shift < 128 {
                        hash |= (*ch as u128) << hash_shift;
                        hash_shift += 8;
                    }
                }
                b'a'..=b'f' => {
                    n_hex += 1;
                    if hash_shift < 128 {
                        hash |= (*ch as u128) << hash_shift;
                        hash_shift += 8;
                    }
                }
                b'g'..=b'z' => {
                    n_alpha += 1;
                    if hash_shift < 128 {
                        hash |= (*ch as u128) << hash_shift;
                        hash_shift += 8;
                    }
                }
                b'A'..=b'F' => {
                    n_hex += 1;
                    n_uppercase += 1;
                    if hash_shift < 128 {
                        hash |= ((*ch - b'A' + b'a') as u128) << hash_shift;
                        hash_shift += 8;
                    }
                }
                b'G'..=b'Z' => {
                    n_alpha += 1;
                    n_uppercase += 1;
                    if hash_shift < 128 {
                        hash |= ((*ch - b'A' + b'a') as u128) << hash_shift;
                        hash_shift += 8;
                    }
                }
                b'@' => {
                    n_at += 1;
                }
                b'.' => {
                    n_dot += 1;
                }
                b'+' => {
                    n_plus += 1;
                }
                b'-' => {
                    n_minus += 1;
                }
                b'\n' => {
                    if !self.stream.try_next_is_space() {
                        self.eof = true;
                        break;
                    } else if n_total > 0 {
                        break;
                    } else {
                        start_pos = self.stream.offset();
                        end_pos = start_pos;
                        continue;
                    }
                }
                b'(' => {
                    if !self.in_quote {
                        self.comment_depth = self.comment_depth.saturating_add(1);
                    }
                    self.next_token = Some(Token::ParenthesisOpen.into());
                    break;
                }
                b')' => {
                    if !self.in_quote {
                        self.comment_depth = self.comment_depth.saturating_sub(1);
                    }
                    self.next_token = Some(Token::ParenthesisClose.into());
                    break;
                }
                b'<' => {
                    self.next_token = Some(Token::AngleOpen.into());
                    break;
                }
                b'>' => {
                    self.next_token = Some(Token::AngleClose.into());
                    break;
                }
                b'[' => {
                    if !self.in_quote {
                        self.bracket_depth = self.comment_depth.saturating_add(1);
                    }
                    self.next_token = Some(Token::BracketOpen.into());
                    break;
                }
                b']' => {
                    if !self.in_quote {
                        self.bracket_depth = self.comment_depth.saturating_sub(1);
                    }
                    self.next_token = Some(Token::BracketClose.into());
                    break;
                }
                b':' => {
                    // The current token might an IPv6 address
                    if self.in_date
                        || n_at > 0
                        || n_dot > 0
                        || n_alpha > 0
                        || n_other > 0
                        || n_plus > 0
                        || n_minus > 0
                        || n_utf > 0
                        || n_colon == 7
                    {
                        self.next_token = Some(Token::Colon.into());
                        break;
                    } else {
                        n_colon += 1;
                    }
                }
                b'=' => {
                    self.next_token = Some(Token::Equal.into());
                    break;
                }
                b';' => {
                    if self.comment_depth == 0 {
                        self.in_date = true;
                    }
                    self.next_token = Some(Token::Semicolon.into());
                    break;
                }
                b'/' => {
                    self.next_token = Some(Token::Slash.into());
                    break;
                }
                b'"' => {
                    self.in_quote = !self.in_quote;
                    self.next_token = Some(Token::Quote.into());
                    break;
                }
                b',' => {
                    self.next_token = Some(Token::Comma.into());
                    break;
                }
                b' ' | b'\t' | b'\r' => {
                    if n_total > 0 {
                        break;
                    } else {
                        start_pos += 1;
                        end_pos = start_pos;
                        continue;
                    }
                }
                0x7f..=u8::MAX => {
                    n_utf += 1;
                }
                b'_' => {
                    n_underscore += 1;
                    n_other += 1;
                }
                _ => {
                    n_other += 1;
                }
            }

            n_total += 1;
            end_pos = self.stream.offset();
        }

        if n_total == 0 {
            return self.next_token.take();
        }

        let text = std::str::from_utf8(self.stream.bytes(start_pos..end_pos)).unwrap_or_default();

        let token = match (
            n_alpha, n_digit, n_hex, n_dot, n_at, n_other, n_colon, n_plus, n_minus, n_utf, hash,
        ) {
            (0, 4..=12, 0, 3, 0, 0, 0, 0, 0, 0, _) => {
                // IPv4 address
                text.parse::<Ipv4Addr>()
                    .map(|ip| Token::IpAddr(IpAddr::V4(ip)))
                    .unwrap_or(Token::Text)
            }
            (0, _, 1..=32, 0, 0, 0, 2.., 0, 0, 0, _)
            | (0, 1..=32, _, 0, 0, 0, 2.., 0, 0, 0, _)
            | (0, 4..=12, 4, 3, 0, 0, 3, 0, 0, 0, _) => {
                // IPv6 address
                text.parse::<Ipv6Addr>()
                    .map(|ip| Token::IpAddr(IpAddr::V6(ip)))
                    .unwrap_or(Token::Text)
            }
            (0, 1.., 0, 0, 0, 0, 0, 0, 0, 0, _)
            | (0, 1.., 0, 0, 0, 0, 0, 0, 1, 0, _)
            | (0, 1.., 0, 0, 0, 0, 0, 1, 0, 0, _) => {
                // Integer
                text.parse::<i64>()
                    .map(Token::Integer)
                    .unwrap_or(Token::Text)
            }
            (1.., _, _, _, 1, _, _, _, _, _, _) | (_, _, 1.., _, 1, _, _, _, _, _, _) => {
                // E-mail address
                Token::Email
            }
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x727061) => Token::Month(Month::Apr),
            (4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x70746d7362) => Token::Protocol(Protocol::SMTP),
            (1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x7962) => Token::By,
            (0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0x636564) => Token::Month(Month::Dec),
            (3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6f6c6865) => Token::Greeting(Greeting::Ehlo),
            (4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x70746d7365) => Token::Protocol(Protocol::ESMTP),
            (4, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x6170746d7365) => Token::Protocol(Protocol::ESMTPA),
            (5, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x7370746d7365) => Token::Protocol(Protocol::ESMTPS),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x726f66) => Token::For,
            (3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6d6f7266) => Token::From,
            (3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6f6c6568) => Token::Greeting(Greeting::Helo),
            (4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x70747468) => Token::Protocol(Protocol::HTTP),
            (7, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x7473657270747468) => Token::Protocol(Protocol::HTTP),
            (1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6469) => Token::Id,
            (3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x70616d69) => Token::Protocol(Protocol::IMAP),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6e616a) => Token::Month(Month::Jan),
            (3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x6c756a) => Token::Month(Month::Jul),
            (3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x6e756a) => Token::Month(Month::Jun),
            (4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x6f6c686c) => Token::Greeting(Greeting::Lhlo),
            (4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x70746d6c) => Token::Protocol(Protocol::LMTP),
            (4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6170746d6c) => Token::Protocol(Protocol::LMTPA),
            (3, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x6c61636f6c) => Token::Protocol(Protocol::Local),
            (5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x70746d736c) => Token::Protocol(Protocol::LMTP),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x72616d) => Token::Month(Month::Mar),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x79616d) => Token::Month(Month::May),
            (3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x766f6e) => Token::Month(Month::Nov),
            (3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x33706f70) => Token::Protocol(Protocol::POP3),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x706573) => Token::Month(Month::Sep),
            (4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x70746d73) => Token::Protocol(Protocol::SMTP),
            (4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6470746d73) => Token::Protocol(Protocol::SMTP),
            (6, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x63767370746d73) => Token::Protocol(Protocol::SMTP),
            (4, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x74656b636f73) => Token::Protocol(Protocol::Local),
            (4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x6e69647473) => Token::Protocol(Protocol::Local),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x616976) => Token::Via,
            (0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0x626566) => Token::Month(Month::Feb),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x677561) => Token::Month(Month::Aug),
            (2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x74636f) => Token::Month(Month::Oct),
            (4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x68746977) => Token::With,
            (4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x70746d7361) => Token::Protocol(Protocol::ESMTPA),
            (5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x7570747468) => Token::Protocol(Protocol::HTTP),
            (5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x7370747468) => Token::Protocol(Protocol::HTTPS),
            (3, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x746e656469) => Token::Ident,
            (5, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x617370746d7365) => Token::Protocol(Protocol::ESMTPSA),
            (5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x7370746d6c) => Token::Protocol(Protocol::LMTPS),
            (5, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x617370746d6c) => Token::Protocol(Protocol::LMTPSA),
            (3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x736d6d) => Token::Protocol(Protocol::MMS),
            (6, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0x70746d7338667475) => {
                Token::Protocol(Protocol::UTF8SMTP)
            }
            (6, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0x6170746d7338667475) => {
                Token::Protocol(Protocol::UTF8SMTPA)
            }
            (7, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0x7370746d7338667475) => {
                Token::Protocol(Protocol::UTF8SMTPS)
            }
            (7, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0x617370746d7338667475) => {
                Token::Protocol(Protocol::UTF8SMTPSA)
            }
            (6, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0x70746d6c38667475) => {
                Token::Protocol(Protocol::UTF8LMTP)
            }
            (6, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0x6170746d6c38667475) => {
                Token::Protocol(Protocol::UTF8LMTPA)
            }
            (7, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0x7370746d6c38667475) => {
                Token::Protocol(Protocol::UTF8LMTPS)
            }
            (7, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0x617370746d6c38667475) => {
                Token::Protocol(Protocol::UTF8LMTPSA)
            }
            (7, 0, 3, 0, 0, 0, 0, 0, _, 0, 0x70746d73656c61636f6c) => {
                Token::Protocol(Protocol::ESMTP)
            }
            (8, 0, 3, 0, 0, 0, 0, 0, _, 0, 0x7370746d73656c61636f6c) => {
                Token::Protocol(Protocol::ESMTPS)
            }
            (7, 0, 3, 0, 0, 0, 0, 0, _, 0, 0x70746d73626c61636f6c) => {
                Token::Protocol(Protocol::SMTP)
            }
            (7, 0, 1, 0, 0, 0, 0, 0, _, 0, 0x736c7470746d7365) => Token::Protocol(Protocol::ESMTPS),
            (3, 2, 0, _, 0, _, 0, 0, _, 0, 0x3031736c74) => Token::TlsVersion(TlsVersion::TLSv1_0),
            (3, 2, 0, _, 0, _, 0, 0, _, 0, 0x3131736c74) => Token::TlsVersion(TlsVersion::TLSv1_1),
            (3, 2, 0, _, 0, _, 0, 0, _, 0, 0x3231736c74) => Token::TlsVersion(TlsVersion::TLSv1_2),
            (3, 2, 0, _, 0, _, 0, 0, _, 0, 0x3331736c74) => Token::TlsVersion(TlsVersion::TLSv1_3),
            (4, 2, 0, _, 0, _, 0, 0, 0, 0, 0x303176736c74) => {
                Token::TlsVersion(TlsVersion::TLSv1_0)
            }
            (4, 2, 0, _, 0, _, 0, 0, 0, 0, 0x313176736c74) => {
                Token::TlsVersion(TlsVersion::TLSv1_1)
            }
            (4, 2, 0, _, 0, _, 0, 0, 0, 0, 0x323176736c74) => {
                Token::TlsVersion(TlsVersion::TLSv1_2)
            }
            (4, 2, 0, _, 0, _, 0, 0, 0, 0, 0x333176736c74) => {
                Token::TlsVersion(TlsVersion::TLSv1_3)
            }
            (3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x326c7373) => Token::TlsVersion(TlsVersion::SSLv2),
            (3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x336c7373) => Token::TlsVersion(TlsVersion::SSLv3),
            (4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x32766c7373) => Token::TlsVersion(TlsVersion::SSLv2),
            (4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x33766c7373) => Token::TlsVersion(TlsVersion::SSLv3),
            (3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x31736c74) => Token::TlsVersion(TlsVersion::TLSv1_0),
            (4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x3176736c74) => Token::TlsVersion(TlsVersion::TLSv1_0),
            (4, 2, 1, _, 0, _, 0, 0, 0, 0, 0x303176736c7464) => {
                Token::TlsVersion(TlsVersion::DTLSv1_0)
            }
            (4, 2, 1, _, 0, _, 0, 0, 0, 0, 0x323176736c7464) => {
                Token::TlsVersion(TlsVersion::DTLSv1_2)
            }
            (4, 2, 1, _, 0, _, 0, 0, 0, 0, 0x333176736c7464) => {
                Token::TlsVersion(TlsVersion::DTLSv1_3)
            }
            (3, 2, 1, _, 0, _, 0, 0, 0, 0, 0x3031736c7464) => {
                Token::TlsVersion(TlsVersion::DTLSv1_0)
            }
            (3, 2, 1, _, 0, _, 0, 0, 0, 0, 0x3231736c7464) => {
                Token::TlsVersion(TlsVersion::DTLSv1_2)
            }
            (3, 2, 1, _, 0, _, 0, 0, 0, 0, 0x3331736c7464) => {
                Token::TlsVersion(TlsVersion::DTLSv1_3)
            }
            (1.., _, _, 1.., 0, 0, 0, 0, _, _, _) | (_, _, 1.., 1.., 0, 0, 0, 0, _, _, _) => {
                // Domain name
                Token::Domain
            }
            _ => {
                // Try ciphersuite
                if n_alpha + n_hex == n_uppercase
                    && n_total > 6
                    && (n_underscore > 0 || n_minus > 0)
                    && n_digit > 0
                    && n_dot == 0
                    && n_at == 0
                    && n_plus == 0
                    && (n_other == 0 || n_other == n_underscore)
                    && n_colon == 0
                    && n_utf == 0
                    && [
                        0x617372, 0x646365, 0x646365, 0x656864, 0x6b7370, 0x707273, 0x736561,
                        0x736564, 0x736c74,
                    ]
                    .contains(&(hash & 0xffffff))
                {
                    Token::Cipher
                } else {
                    Token::Text
                }
            }
        };

        TokenData {
            text,
            token,
            comment_depth,
            bracket_depth,
        }
        .into()
    }
}

impl<'x, 'y> Tokenizer<'x, 'y> {
    fn new(stream: &'y mut MessageStream<'x>) -> Self {
        Self {
            stream,
            next_token: None,
            eof: false,
            in_quote: false,
            bracket_depth: 0,
            comment_depth: 0,
            in_date: false,
        }
    }
}

impl From<Token> for TokenData<'_> {
    fn from(token: Token) -> Self {
        Self {
            token,
            text: "",
            comment_depth: 0,
            bracket_depth: 0,
        }
    }
}

impl Month {
    fn to_number(self) -> i64 {
        match self {
            Month::Jan => 1,
            Month::Feb => 2,
            Month::Mar => 3,
            Month::Apr => 4,
            Month::May => 5,
            Month::Jun => 6,
            Month::Jul => 7,
            Month::Aug => 8,
            Month::Sep => 9,
            Month::Oct => 10,
            Month::Nov => 11,
            Month::Dec => 12,
        }
    }
}

impl Token {
    fn is_separator(&self) -> bool {
        matches!(
            self,
            Token::BracketOpen
                | Token::BracketClose
                | Token::AngleOpen
                | Token::AngleClose
                | Token::ParenthesisOpen
                | Token::ParenthesisClose
                | Token::Semicolon
                | Token::Colon
                | Token::Equal
                | Token::Slash
                | Token::Quote
                | Token::Comma
        )
    }
}

#[cfg(test)]
mod tests {

    use crate::{
        MessageParser,
        parsers::{MessageStream, fields::load_tests},
    };

    #[test]
    fn parse_received() {
        for test in load_tests("received.json") {
            assert_eq!(
                MessageStream::new(test.header.as_bytes())
                    .parse_received()
                    .unwrap_received(),
                test.expected,
                "failed for {:?}",
                test.header
            );
        }
    }

    #[test]
    fn parse_received_truncated_fold() {
        for message in [
            &b"Received:\n\t"[..],
            b"Received:\r\n ",
            b"Received: x\r\n ",
            b"Received: x\r\n\t",
            b"Received: x\n ",
            b"Received: x\n\t",
            b"Received: x\r\n  ",
            b"Received: x\r\n \t",
            b"Received: x\r\n \t ",
            b"Received: x\r\n \r",
            b"Received: x\r\n \r\n",
            b"Received: x\r\n \r\nbody",
            b"Received: x\r\n y\r\n ",
            b"Received: x;\r\n ",
            b"To: a@b\r\nReceived: x\r\n ",
            b"Received: from x (y)\r\n\t",
            b"Received: from x by y;\r\n\t",
            b"Received: ",
            b"Received:",
            b"Received: x",
        ] {
            MessageParser::default().parse(message);
            MessageParser::default().parse_headers(message);
        }
    }
}
