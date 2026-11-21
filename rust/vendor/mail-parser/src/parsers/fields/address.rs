/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{Addr, Address, Group, HeaderValue, parsers::MessageStream};
use std::borrow::Cow;

#[derive(PartialEq, Clone, Copy, Debug)]
enum AddressState {
    Address,
    Name,
    Quote,
    Comment,
}

pub struct AddressParser<'x> {
    token_start: usize,
    token_end: usize,

    is_token_email: bool,
    is_token_start: bool,
    is_escaped: bool,
    last_is_encoded: bool,

    name_tokens: Vec<Cow<'x, str>>,
    mail_tokens: Vec<Cow<'x, str>>,
    comment_tokens: Vec<Cow<'x, str>>,

    state: AddressState,
    state_stack: Vec<AddressState>,

    addresses: Vec<Addr<'x>>,
    group_name: Option<Cow<'x, str>>,
    group_comment: Option<Cow<'x, str>>,
    result: Vec<Group<'x>>,
}

impl<'x> AddressParser<'x> {
    pub fn add_token(&mut self, stream: &MessageStream<'x>) {
        if self.token_start > 0 {
            let token = String::from_utf8_lossy(&stream.data[self.token_start - 1..self.token_end]);
            let mut add_space = false;
            let list = match self.state {
                AddressState::Address => &mut self.mail_tokens,
                AddressState::Name => {
                    if self.is_token_email {
                        &mut self.mail_tokens
                    } else {
                        add_space = true;
                        &mut self.name_tokens
                    }
                }
                AddressState::Quote => &mut self.name_tokens,
                AddressState::Comment => {
                    add_space = true;
                    &mut self.comment_tokens
                }
            };

            if add_space && !list.is_empty() {
                list.push(" ".into());
            }

            list.push(token);

            self.token_start = 0;
            self.is_token_email = false;
            self.is_token_start = true;
            self.is_escaped = false;
            self.last_is_encoded = false;
        }
    }

    pub fn add_rfc2047(&mut self, token: String) {
        let add_space = !self.last_is_encoded && self.state != AddressState::Quote;
        let list = if self.state != AddressState::Comment {
            &mut self.name_tokens
        } else {
            &mut self.comment_tokens
        };

        if add_space && !list.is_empty() {
            list.push(" ".into());
        }

        list.push(token.into());
        self.last_is_encoded = true;
    }

    pub fn add_address(&mut self) {
        let has_mail = !self.mail_tokens.is_empty();
        let has_name = !self.name_tokens.is_empty();
        let has_comment = !self.comment_tokens.is_empty();

        self.addresses.push(if has_mail && has_name && has_comment {
            Addr {
                name: Some(
                    format!(
                        "{} ({})",
                        concat_tokens(&mut self.name_tokens),
                        concat_tokens(&mut self.comment_tokens)
                    )
                    .into(),
                ),
                address: concat_tokens(&mut self.mail_tokens).into(),
            }
        } else if has_name && has_mail {
            Addr {
                name: concat_tokens(&mut self.name_tokens).into(),
                address: concat_tokens(&mut self.mail_tokens).into(),
            }
        } else if has_mail && has_comment {
            Addr {
                name: concat_tokens(&mut self.comment_tokens).into(),
                address: concat_tokens(&mut self.mail_tokens).into(),
            }
        } else if has_mail {
            Addr {
                name: None,
                address: concat_tokens(&mut self.mail_tokens).into(),
            }
        } else if has_name && has_comment {
            let name = concat_tokens(&mut self.name_tokens);
            let comment = concat_tokens(&mut self.comment_tokens);

            if !name.chars().any(char::is_whitespace) {
                Addr {
                    name: comment.into(),
                    address: name.into(),
                }
            } else {
                Addr {
                    name: Some(format!("{name} ({comment})").into()),
                    address: None,
                }
            }
        } else if has_name {
            Addr {
                name: concat_tokens(&mut self.name_tokens).into(),
                address: None,
            }
        } else if has_comment {
            Addr {
                name: concat_tokens(&mut self.comment_tokens).into(),
                address: None,
            }
        } else {
            return;
        });
    }

    pub fn add_group_details(&mut self) {
        if !self.name_tokens.is_empty() {
            self.group_name = concat_tokens(&mut self.name_tokens).into();
        }

        if !self.comment_tokens.is_empty() {
            self.group_comment = concat_tokens(&mut self.comment_tokens).into();
        }

        if !self.mail_tokens.is_empty() {
            if let Some(group_name) = &self.group_name {
                self.group_name =
                    Some(format!("{} {}", group_name, concat_tokens(&mut self.mail_tokens)).into());
            } else {
                self.group_name = concat_tokens(&mut self.mail_tokens).into();
            }
        }
    }

    pub fn add_group(&mut self) {
        let has_name = self.group_name.is_some();
        let has_comment = self.group_comment.is_some();
        let has_addresses = !self.addresses.is_empty();

        self.result
            .push(if has_name && has_addresses && has_comment {
                Group {
                    name: Some(
                        format!(
                            "{} ({})",
                            self.group_name.take().unwrap(),
                            self.group_comment.take().unwrap()
                        )
                        .into(),
                    ),
                    addresses: std::mem::take(&mut self.addresses),
                }
            } else if has_addresses && has_name {
                Group {
                    name: self.group_name.take(),
                    addresses: std::mem::take(&mut self.addresses),
                }
            } else if has_addresses {
                Group {
                    name: self.group_comment.take(),
                    addresses: std::mem::take(&mut self.addresses),
                }
            } else if has_name {
                Group {
                    name: self.group_name.take(),
                    addresses: Vec::new(),
                }
            } else {
                return;
            });
    }
}

impl<'x> MessageStream<'x> {
    pub fn parse_address(&mut self) -> HeaderValue<'x> {
        let mut parser = AddressParser {
            token_start: 0,
            token_end: 0,

            is_token_email: false,
            is_token_start: true,
            is_escaped: false,
            last_is_encoded: true,

            name_tokens: Vec::with_capacity(3),
            mail_tokens: Vec::with_capacity(3),
            comment_tokens: Vec::with_capacity(3),

            state: AddressState::Name,
            state_stack: Vec::with_capacity(5),

            addresses: Vec::new(),
            group_name: None,
            group_comment: None,
            result: Vec::new(),
        };

        while let Some(ch) = self.next() {
            match ch {
                b'\n' => {
                    parser.add_token(self);
                    if parser.state == AddressState::Quote {
                        if self.peek_next_is_space() {
                            continue;
                        } else {
                            break;
                        }
                    }
                    if self.try_next_is_space() {
                        if !parser.is_token_start {
                            parser.is_token_start = true;
                        }
                        continue;
                    } else {
                        break;
                    }
                }
                b'\\' if parser.state != AddressState::Name && !parser.is_escaped => {
                    if parser.token_start > 0 {
                        if parser.state == AddressState::Quote {
                            parser.token_end = self.offset() - 1;
                        }
                        parser.add_token(self);
                    }
                    parser.is_escaped = true;
                    continue;
                }
                b',' if parser.state == AddressState::Name => {
                    parser.add_token(self);
                    parser.add_address();
                    continue;
                }
                b'<' if parser.state == AddressState::Name => {
                    parser.is_token_email = false;
                    parser.add_token(self);
                    parser.state_stack.push(AddressState::Name);
                    parser.state = AddressState::Address;
                    continue;
                }
                b'>' if parser.state == AddressState::Address => {
                    parser.add_token(self);
                    parser.state = parser.state_stack.pop().unwrap();
                    continue;
                }
                b'"' if !parser.is_escaped => match parser.state {
                    AddressState::Name => {
                        parser.state_stack.push(AddressState::Name);
                        parser.state = AddressState::Quote;
                        parser.add_token(self);
                        continue;
                    }
                    AddressState::Quote => {
                        parser.add_token(self);
                        parser.state = parser.state_stack.pop().unwrap();
                        continue;
                    }
                    _ => (),
                },
                b'@' if parser.state == AddressState::Name => {
                    parser.is_token_email = true;
                }
                b'=' if parser.is_token_start && !parser.is_escaped && self.peek_char(b'?') => {
                    self.checkpoint();
                    if let Some(token) = self.decode_rfc2047() {
                        parser.add_token(self);
                        parser.add_rfc2047(token);
                        continue;
                    }
                    self.restore();
                }
                b' ' | b'\t' => {
                    if !parser.is_token_start {
                        parser.is_token_start = true;
                    }
                    if parser.is_escaped {
                        parser.is_escaped = false;
                    }
                    if parser.state == AddressState::Quote {
                        if parser.token_start == 0 {
                            parser.token_start = self.offset();
                            parser.token_end = parser.token_start;
                        } else {
                            parser.token_end = self.offset();
                        }
                    }
                    continue;
                }
                b'\r' => continue,
                b'(' if parser.state != AddressState::Quote && !parser.is_escaped => {
                    parser.state_stack.push(parser.state);
                    if parser.state != AddressState::Comment {
                        parser.add_token(self);
                        parser.state = AddressState::Comment;
                        parser.last_is_encoded = false;
                        continue;
                    }
                }
                b')' if parser.state == AddressState::Comment && !parser.is_escaped => {
                    let new_state = parser.state_stack.pop().unwrap();
                    if parser.state != new_state {
                        parser.add_token(self);
                        parser.state = new_state;
                        parser.last_is_encoded = false;
                        continue;
                    }
                }
                b':' if parser.state == AddressState::Name && !parser.is_escaped => {
                    parser.add_group();
                    parser.add_token(self);
                    parser.add_group_details();
                    continue;
                }
                b';' if parser.state == AddressState::Name => {
                    parser.add_token(self);
                    parser.add_address();
                    parser.add_group();
                    continue;
                }
                _ => (),
            }

            if parser.is_escaped {
                parser.is_escaped = false;
            }

            if parser.is_token_start {
                parser.is_token_start = false;
            }

            if parser.token_start == 0 {
                parser.token_start = self.offset();
                parser.token_end = parser.token_start;
            } else {
                parser.token_end = self.offset();
            }
        }

        parser.add_address();

        if parser.group_name.is_some() || !parser.result.is_empty() {
            parser.add_group();
            HeaderValue::Address(Address::Group(parser.result))
        } else if !parser.addresses.is_empty() {
            HeaderValue::Address(Address::List(parser.addresses))
        } else {
            HeaderValue::Empty
        }
    }
}

fn concat_tokens<'x>(tokens: &mut Vec<Cow<'x, str>>) -> Cow<'x, str> {
    if tokens.len() == 1 {
        tokens.pop().unwrap()
    } else {
        let result = tokens.concat();
        tokens.clear();
        result.into()
    }
}

pub fn parse_address_local_part(addr: &str) -> Option<&str> {
    let addr = addr.as_bytes();
    let mut iter = addr.iter().enumerate();
    while let Some((pos, &ch)) = iter.next() {
        if ch == b'@' {
            return if pos > 0 && iter.next().is_some() {
                std::str::from_utf8(addr.get(..pos)?).ok()
            } else {
                None
            };
        } else if !ch.is_ascii() {
            return None;
        }
    }

    None
}

pub fn parse_address_domain(addr: &str) -> Option<&str> {
    let addr = addr.as_bytes();
    for (pos, &ch) in addr.iter().enumerate() {
        if ch == b'@' {
            return if pos > 0 && pos + 1 < addr.len() {
                std::str::from_utf8(addr.get(pos + 1..)?).ok()
            } else {
                None
            };
        } else if !ch.is_ascii() {
            return None;
        }
    }

    None
}

pub fn parse_address_user_part(addr: &str) -> Option<&str> {
    let addr = addr.as_bytes();

    let mut iter = addr.iter().enumerate();
    while let Some((pos, &ch)) = iter.next() {
        if ch == b'+' {
            if pos > 0 {
                while let Some((_, &ch)) = iter.next() {
                    if ch == b'@' && iter.next().is_some() {
                        return std::str::from_utf8(addr.get(..pos)?).ok();
                    }
                }
            }
            return None;
        } else if ch == b'@' {
            return if pos > 0 && iter.next().is_some() {
                std::str::from_utf8(addr.get(..pos)?).ok()
            } else {
                None
            };
        } else if !ch.is_ascii() {
            return None;
        }
    }

    None
}

pub fn parse_address_detail_part(addr: &str) -> Option<&str> {
    let addr = addr.as_bytes();
    let mut plus_pos = usize::MAX;

    let mut iter = addr.iter().enumerate();
    while let Some((pos, &ch)) = iter.next() {
        if ch == b'+' {
            plus_pos = pos + 1;
        } else if ch == b'@' {
            if plus_pos != usize::MAX && iter.next().is_some() {
                return std::str::from_utf8(addr.get(plus_pos..pos)?).ok();
            } else {
                return None;
            }
        } else if !ch.is_ascii() {
            return None;
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use crate::parsers::{MessageStream, fields::load_tests};

    #[test]
    fn parse_addresses() {
        for test in load_tests("address.json") {
            assert_eq!(
                MessageStream::new(test.header.as_bytes())
                    .parse_address()
                    .unwrap_address(),
                test.expected,
                "failed for {:?}",
                test.header
            );
        }
    }
}
