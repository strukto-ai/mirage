/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::{
    Attribute, ContentType, HeaderValue,
    decoders::{charsets::map::charset_decoder, hex::decode_hex},
    parsers::MessageStream,
};

#[derive(Clone, Copy, PartialEq, Debug)]
enum ContentState {
    Type,
    SubType,
    AttributeName,
    AttributeValue,
    AttributeQuotedValue,
    Comment,
}

type Continuation<'x> = (Cow<'x, str>, u32, Cow<'x, str>);

struct ContentTypeParser<'x> {
    state: ContentState,
    state_stack: Vec<ContentState>,

    c_type: Option<Cow<'x, str>>,
    c_subtype: Option<Cow<'x, str>>,

    attr_name: Option<Cow<'x, str>>,
    attr_charset: Option<Cow<'x, str>>,
    attr_position: u32,

    values: Vec<Cow<'x, str>>,
    attributes: Vec<Attribute<'x>>,
    continuations: Option<Vec<Continuation<'x>>>,

    token_start: usize,
    token_end: usize,

    is_continuation: bool,
    is_encoded_attribute: bool,
    is_escaped: bool,
    remove_crlf: bool,
    is_lower_case: bool,
    is_token_start: bool,
}

impl<'x> ContentTypeParser<'x> {
    #[inline(always)]
    fn reset_parser(&mut self) {
        self.token_start = 0;
        self.is_token_start = true;
    }

    fn add_attribute(&mut self, stream: &MessageStream<'x>) -> bool {
        if self.token_start > 0 {
            let mut attr = Some(String::from_utf8_lossy(
                &stream.data[self.token_start - 1..self.token_end],
            ));

            if !self.is_lower_case {
                attr.as_mut().unwrap().to_mut().make_ascii_lowercase();
                self.is_lower_case = true;
            }

            match self.state {
                ContentState::AttributeName => self.attr_name = attr,
                ContentState::Type => self.c_type = attr,
                ContentState::SubType => self.c_subtype = attr,
                _ => unreachable!(),
            }

            self.reset_parser();
            true
        } else {
            false
        }
    }

    fn add_attribute_parameter(&mut self, stream: &MessageStream<'x>) {
        if self.token_start > 0 {
            let attr_part =
                String::from_utf8_lossy(&stream.data[self.token_start - 1..self.token_end]);

            if self.attr_charset.is_none() {
                self.attr_charset = attr_part.into();
            } else {
                let attr_name =
                    self.attr_name.as_ref().unwrap_or(&"unknown".into()).clone() + "-language";

                if !self.attributes.iter().any(|a| a.name == attr_name) {
                    self.attributes.push(Attribute {
                        name: attr_name,
                        value: attr_part,
                    });
                } else {
                    self.values.push("'".into());
                    self.values.push(attr_part);
                }
            }

            self.reset_parser();
        }
    }

    fn add_partial_value(&mut self, stream: &MessageStream<'x>, to_cur_pos: bool) {
        if self.token_start > 0 {
            let in_quote = self.state == ContentState::AttributeQuotedValue;

            self.values.push(String::from_utf8_lossy(
                &stream.data[self.token_start - 1..if in_quote && to_cur_pos {
                    stream.offset() - 1
                } else {
                    self.token_end
                }],
            ));
            if !in_quote {
                self.values.push(" ".into());
            }

            self.reset_parser();
        }
    }

    fn add_value(&mut self, stream: &MessageStream<'x>) {
        if self.attr_name.is_none() {
            return;
        }

        let has_values = !self.values.is_empty();
        let value = if self.token_start > 0 {
            let value = &stream.data[self.token_start - 1..self.token_end];
            Some(if !self.remove_crlf {
                String::from_utf8_lossy(value)
            } else {
                self.remove_crlf = false;
                match String::from_utf8(
                    value
                        .iter()
                        .filter(|&&ch| ch != b'\r' && ch != b'\n')
                        .copied()
                        .collect::<Vec<_>>(),
                ) {
                    Ok(value) => value.into(),
                    Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned().into(),
                }
            })
        } else {
            if !has_values {
                return;
            }
            None
        };

        if !self.is_continuation {
            self.attributes.push(Attribute {
                name: self.attr_name.take().unwrap(),
                value: if !has_values {
                    value.unwrap()
                } else {
                    if let Some(value) = value {
                        self.values.push(value);
                    }
                    self.values.concat().into()
                },
            });
        } else {
            let attr_name = self.attr_name.take().unwrap();
            let mut value = if let Some(value) = value {
                if has_values {
                    Cow::from(self.values.concat()) + value
                } else {
                    value
                }
            } else {
                self.values.concat().into()
            };

            if self.is_encoded_attribute {
                if let (true, decoded_bytes) = decode_hex(value.as_bytes()) {
                    value = if let Some(decoder) = self
                        .attr_charset
                        .as_ref()
                        .and_then(|c| charset_decoder(c.as_bytes()))
                    {
                        decoder(&decoded_bytes).into()
                    } else {
                        String::from_utf8(decoded_bytes)
                            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
                            .into()
                    }
                }
                self.is_encoded_attribute = false;
            }

            if self.attr_position > 0 {
                let continuation = (attr_name, self.attr_position, value);
                if let Some(continuations) = self.continuations.as_mut() {
                    continuations.push(continuation);
                } else {
                    self.continuations = Some(vec![continuation]);
                }

                self.attr_position = 0;
            } else {
                self.attributes.push(Attribute {
                    name: attr_name,
                    value,
                });
            }
            self.is_continuation = false;
            self.attr_charset = None;
        }

        if has_values {
            self.values.clear();
        }

        self.reset_parser();
    }

    fn add_attr_position(&mut self, stream: &MessageStream<'_>) -> bool {
        if self.token_start > 0 {
            self.attr_position =
                String::from_utf8_lossy(&stream.data[self.token_start - 1..self.token_end])
                    .parse()
                    .unwrap_or(0);

            self.reset_parser();
            true
        } else {
            false
        }
    }

    fn merge_continuations(&mut self) {
        let continuations = self.continuations.as_mut().unwrap();
        continuations.sort();
        for (key, _, value) in continuations.drain(..) {
            if let Some(old) = self.attributes.iter_mut().find(|a| a.name == key) {
                old.value = format!("{}{value}", old.value).into();
            } else {
                self.attributes.push(Attribute { name: key, value });
            }
        }
    }
}

impl<'x> MessageStream<'x> {
    pub fn parse_content_type(&mut self) -> HeaderValue<'x> {
        let mut parser = ContentTypeParser {
            state: ContentState::Type,
            state_stack: Vec::new(),

            c_type: None,
            c_subtype: None,

            attr_name: None,
            attr_charset: None,
            attr_position: 0,

            attributes: Vec::new(),
            values: Vec::new(),
            continuations: None,

            is_continuation: false,
            is_encoded_attribute: false,
            is_lower_case: true,
            is_token_start: true,
            is_escaped: false,
            remove_crlf: false,

            token_start: 0,
            token_end: 0,
        };

        while let Some(ch) = self.next() {
            match ch {
                b' ' | b'\t' => {
                    if !parser.is_token_start {
                        parser.is_token_start = true;
                    }
                    if let ContentState::AttributeQuotedValue = parser.state {
                        if parser.token_start == 0 {
                            parser.token_start = self.offset();
                            parser.token_end = parser.token_start;
                        } else {
                            parser.token_end = self.offset();
                        }
                    }
                    continue;
                }
                b'A'..=b'Z' if parser.is_lower_case => {
                    if let ContentState::Type
                    | ContentState::SubType
                    | ContentState::AttributeName = parser.state
                    {
                        parser.is_lower_case = false;
                    }
                }
                b'\n' => {
                    let next_is_space = self.peek_next_is_space();
                    match parser.state {
                        ContentState::Type
                        | ContentState::AttributeName
                        | ContentState::SubType => {
                            parser.add_attribute(self);
                        }
                        ContentState::AttributeValue => {
                            parser.add_value(self);
                        }
                        ContentState::AttributeQuotedValue => {
                            if next_is_space {
                                self.next();
                                parser.remove_crlf = true;
                                continue;
                            } else {
                                parser.add_value(self);
                            }
                        }
                        _ => (),
                    }

                    if next_is_space {
                        if parser.state == ContentState::Type {
                            continue;
                        }
                        parser.state = ContentState::AttributeName;
                        self.next();

                        if !parser.is_token_start {
                            parser.is_token_start = true;
                        }
                        continue;
                    } else {
                        if parser.continuations.is_some() {
                            parser.merge_continuations();
                        }

                        return if let Some(content_type) = parser.c_type {
                            HeaderValue::ContentType(ContentType {
                                c_type: content_type,
                                c_subtype: parser.c_subtype.take(),
                                attributes: if !parser.attributes.is_empty() {
                                    Some(parser.attributes)
                                } else {
                                    None
                                },
                            })
                        } else {
                            HeaderValue::Empty
                        };
                    }
                }
                b'/' if parser.state == ContentState::Type => {
                    parser.add_attribute(self);
                    parser.state = ContentState::SubType;
                    continue;
                }
                b';' => match parser.state {
                    ContentState::Type | ContentState::SubType | ContentState::AttributeName => {
                        parser.add_attribute(self);
                        parser.state = ContentState::AttributeName;
                        continue;
                    }
                    ContentState::AttributeValue => {
                        if !parser.is_escaped {
                            parser.add_value(self);
                            parser.state = ContentState::AttributeName;
                        } else {
                            parser.is_escaped = false;
                        }
                        continue;
                    }
                    _ => (),
                },
                b'*' if parser.state == ContentState::AttributeName => {
                    if !parser.is_continuation {
                        parser.is_continuation = parser.add_attribute(self);
                    } else if !parser.is_encoded_attribute {
                        parser.add_attr_position(self);
                        parser.is_encoded_attribute = true;
                    } else {
                        // Malformed data, reset parser.
                        parser.reset_parser();
                    }
                    continue;
                }
                b'=' => match parser.state {
                    ContentState::AttributeName => {
                        if !parser.is_continuation {
                            if !parser.add_attribute(self) {
                                continue;
                            }
                        } else if !parser.is_encoded_attribute {
                            /* If is_continuation=true && is_encoded_attribute=false,
                            the last character was a '*' which means encoding */
                            parser.is_encoded_attribute = !parser.add_attr_position(self);
                        } else {
                            parser.reset_parser();
                        }
                        parser.state = ContentState::AttributeValue;
                        continue;
                    }
                    ContentState::AttributeValue | ContentState::AttributeQuotedValue
                        if parser.is_token_start && self.peek_char(b'?') =>
                    {
                        self.checkpoint();
                        if let Some(token) = self.decode_rfc2047() {
                            parser.add_partial_value(self, false);
                            parser.values.push(token.into());
                            continue;
                        }
                        self.restore();
                    }
                    _ => (),
                },
                b'\"' => match parser.state {
                    ContentState::AttributeValue => {
                        if !parser.is_token_start {
                            parser.is_token_start = true;
                        }
                        parser.state = ContentState::AttributeQuotedValue;
                        continue;
                    }
                    ContentState::AttributeQuotedValue => {
                        if !parser.is_escaped {
                            parser.add_value(self);
                            parser.state = ContentState::AttributeName;
                            continue;
                        } else {
                            parser.is_escaped = false;
                        }
                    }
                    _ => continue,
                },
                b'\\' => match parser.state {
                    ContentState::AttributeQuotedValue | ContentState::AttributeValue => {
                        if !parser.is_escaped {
                            parser.add_partial_value(self, true);
                            parser.is_escaped = true;
                            continue;
                        } else {
                            parser.is_escaped = false;
                        }
                    }
                    ContentState::Comment => parser.is_escaped = !parser.is_escaped,
                    _ => continue,
                },
                b'\''
                    if parser.is_encoded_attribute
                        && !parser.is_escaped
                        && (parser.state == ContentState::AttributeValue
                            || parser.state == ContentState::AttributeQuotedValue) =>
                {
                    parser.add_attribute_parameter(self);
                    continue;
                }
                b'(' if parser.state != ContentState::AttributeQuotedValue => {
                    if !parser.is_escaped {
                        match parser.state {
                            ContentState::Type
                            | ContentState::AttributeName
                            | ContentState::SubType => {
                                parser.add_attribute(self);
                            }
                            ContentState::AttributeValue => {
                                parser.add_value(self);
                            }
                            _ => (),
                        }

                        parser.state_stack.push(parser.state);
                        parser.state = ContentState::Comment;
                    } else {
                        parser.is_escaped = false;
                    }
                    continue;
                }
                b')' if parser.state == ContentState::Comment => {
                    if !parser.is_escaped {
                        parser.state = parser.state_stack.pop().unwrap();
                        parser.reset_parser();
                    } else {
                        parser.is_escaped = false;
                    }
                    continue;
                }
                b'\r' => continue,
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

        HeaderValue::Empty
    }
}
#[cfg(test)]
mod tests {
    use crate::parsers::{MessageStream, fields::load_tests};

    #[test]
    fn parse_content_fields() {
        for test in load_tests("content_type.json") {
            assert_eq!(
                MessageStream::new(test.header.as_bytes())
                    .parse_content_type()
                    .into_content_type(),
                test.expected,
                "failed for {:?}",
                test.header
            );
        }

        /*let mut builder = crate::parsers::fields::TestBuilder::new("content_type.json");

        for input in inputs {
            println!("Testing: {:?}", input.0);
            let result = MessageStream::new(input.0.as_bytes())
                .parse_content_type()
                .into_content_type();

            builder.add(input.0.to_string(), result);
        }

        builder.write();*/
    }
}
