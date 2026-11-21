/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::{
    ContentType, Encoding, GetHeader, HeaderName, HeaderValue, Message, MessageParser, MessagePart,
    MessagePartId, PartType,
    decoders::{DecodeFnc, charsets::map::charset_decoder},
};

use super::MessageStream;

const MAX_NESTED_ENCODED: usize = 3;

#[derive(Debug, PartialEq, Default)]
enum MimeType {
    MultipartMixed,
    MultipartAlternative,
    MultipartRelated,
    MultipartDigest,
    TextPlain,
    TextHtml,
    TextOther,
    Inline,
    #[default]
    Message,
    Other,
}

#[inline(always)]
fn mime_type(
    content_type: Option<&ContentType<'_>>,
    parent_content_type: &MimeType,
) -> (bool, bool, bool, MimeType) {
    if let Some(content_type) = content_type {
        match content_type.ctype() {
            "multipart" => (
                true,
                false,
                false,
                match content_type.subtype() {
                    Some("mixed") => MimeType::MultipartMixed,
                    Some("alternative") => MimeType::MultipartAlternative,
                    Some("related") => MimeType::MultipartRelated,
                    Some("digest") => MimeType::MultipartDigest,
                    _ => MimeType::Other,
                },
            ),
            "text" => match content_type.subtype() {
                Some("plain") => (false, true, true, MimeType::TextPlain),
                Some("html") => (false, true, true, MimeType::TextHtml),
                _ => (false, false, true, MimeType::TextOther),
            },
            "image" | "audio" | "video" => (false, true, false, MimeType::Inline),
            "message" if [Some("rfc822"), Some("global")].contains(&content_type.subtype()) => {
                (false, false, false, MimeType::Message)
            }
            _ => (false, false, false, MimeType::Other),
        }
    } else if let MimeType::MultipartDigest = parent_content_type {
        (false, false, false, MimeType::Message)
    } else {
        (false, true, true, MimeType::TextPlain)
    }
}

#[derive(Default, Debug)]
struct MessageParserState {
    mime_type: MimeType,
    mime_boundary: Option<Vec<u8>>,
    in_alternative: bool,
    parts: usize,
    html_parts: usize,
    text_parts: usize,
    need_html_body: bool,
    need_text_body: bool,
    part_id: MessagePartId,
    sub_part_ids: Vec<MessagePartId>,
    offset_header: usize,
    offset_body: usize,
    offset_end: usize,
}

impl MessageParserState {
    fn new() -> MessageParserState {
        MessageParserState {
            mime_type: MimeType::Message,
            mime_boundary: None,
            in_alternative: false,
            parts: 0,
            html_parts: 0,
            text_parts: 0,
            need_text_body: true,
            need_html_body: true,
            ..Default::default()
        }
    }
}

impl MessageParser {
    /// Parses a byte slice containing the RFC5322 raw message and returns a
    /// `Message` struct.
    ///
    /// This function never panics, a best-effort is made to parse the message and
    /// if no headers are found None is returned.
    ///
    pub fn parse<'x>(&self, raw_message: &'x (impl AsRef<[u8]> + ?Sized)) -> Option<Message<'x>> {
        self.parse_(raw_message.as_ref(), MAX_NESTED_ENCODED, false)
    }

    /// Parses a byte slice containing the RFC5322 raw message and returns a
    /// `Message` struct containing only the headers.
    pub fn parse_headers<'x>(
        &self,
        raw_message: &'x (impl AsRef<[u8]> + ?Sized),
    ) -> Option<Message<'x>> {
        self.parse_(raw_message.as_ref(), MAX_NESTED_ENCODED, true)
    }

    fn parse_<'x>(
        &self,
        raw_message: &'x [u8],
        depth: usize,
        skip_body: bool,
    ) -> Option<Message<'x>> {
        let mut stream = MessageStream::new(raw_message);

        let mut message = Message::new();

        let mut state = MessageParserState::new();
        let mut state_stack = Vec::with_capacity(4);

        let mut part_headers = Vec::new();

        'outer: loop {
            // Parse headers
            state.offset_header = stream.offset();
            if !stream.parse_headers(self, &mut part_headers) {
                break;
            }
            state.offset_body = stream.offset();
            if skip_body {
                break;
            }

            state.parts += 1;
            state.sub_part_ids.push(message.parts.len() as u32);

            let content_type = part_headers
                .header_value(&HeaderName::ContentType)
                .and_then(|c| c.as_content_type());

            let (is_multipart, mut is_inline, mut is_text, mut mime_type) =
                mime_type(content_type, &state.mime_type);

            if is_multipart
                && let Some(mime_boundary) = content_type.and_then(|f| f.attribute("boundary"))
            {
                if stream.seek_next_part(mime_boundary.as_bytes()) {
                    let part_id = message.parts.len();
                    let new_state = MessageParserState {
                        in_alternative: state.in_alternative
                            || mime_type == MimeType::MultipartAlternative,
                        mime_type,
                        mime_boundary: mime_boundary.as_bytes().to_vec().into(),
                        html_parts: message.html_body.len(),
                        text_parts: message.text_body.len(),
                        need_html_body: state.need_html_body,
                        need_text_body: state.need_text_body,
                        part_id: part_id as u32,
                        ..Default::default()
                    };
                    //add_missing_type(&mut part_header, "text".into(), "plain".into());
                    message.parts.push(MessagePart {
                        headers: std::mem::take(&mut part_headers),
                        offset_header: state.offset_header as u32,
                        offset_body: state.offset_body as u32,
                        offset_end: 0,
                        is_encoding_problem: false,
                        encoding: Encoding::None,
                        body: PartType::default(),
                    });
                    state_stack.push((state, None));
                    state = new_state;
                    stream.skip_crlf();
                    continue;
                } else {
                    mime_type = MimeType::TextOther;
                    is_text = true;
                }
            }

            let (mut encoding, decode_fnc): (Encoding, DecodeFnc<'_>) = match part_headers
                .header_value(&HeaderName::ContentTransferEncoding)
            {
                Some(HeaderValue::Text(encoding)) if encoding.eq_ignore_ascii_case("base64") => {
                    (Encoding::Base64, MessageStream::decode_base64_mime)
                }
                Some(HeaderValue::Text(encoding))
                    if encoding.eq_ignore_ascii_case("quoted-printable") =>
                {
                    (
                        Encoding::QuotedPrintable,
                        MessageStream::decode_quoted_printable_mime,
                    )
                }
                _ => (Encoding::None, MessageStream::mime_part),
            };

            if mime_type == MimeType::Message && encoding == Encoding::None {
                let new_state = MessageParserState {
                    mime_type: MimeType::Message,
                    mime_boundary: state.mime_boundary.take(),
                    need_html_body: true,
                    need_text_body: true,
                    part_id: message.parts.len() as u32,
                    ..Default::default()
                };
                message.attachments.push(message.parts.len() as u32);
                message.parts.push(MessagePart {
                    headers: std::mem::take(&mut part_headers),
                    encoding,
                    is_encoding_problem: false,
                    offset_header: state.offset_header as u32,
                    offset_body: state.offset_body as u32,
                    offset_end: 0,
                    body: PartType::default(), // Temp value, will be replaced later.
                });
                state_stack.push((state, message.into()));
                message = Message::new();
                state = new_state;
                continue;
            }

            let (offset_end, mut bytes) = decode_fnc(
                &mut stream,
                state.mime_boundary.as_deref().unwrap_or(&b""[..]),
            );

            // Attempt to recover contents of an invalid message
            let mut is_encoding_problem = offset_end == usize::MAX;
            if is_encoding_problem {
                encoding = Encoding::None;
                if mime_type != MimeType::TextPlain {
                    mime_type = MimeType::TextOther;
                }
                is_inline = false;
                is_text = true;

                let (offset_end, boundary_found) =
                    stream.seek_part_end(state.mime_boundary.as_deref());
                state.offset_end = offset_end;
                bytes = stream.data[state.offset_body..state.offset_end].into();

                if !boundary_found {
                    state.mime_boundary = None;
                }
            } else {
                state.offset_end = offset_end;
            }

            let body_part = if mime_type != MimeType::Message {
                let is_inline = is_inline
                    && part_headers
                        .header_value(&HeaderName::ContentDisposition)
                        .is_none_or(|d| !d.as_content_type().is_some_and(|ct| ct.is_attachment()))
                    && (state.parts == 1
                        || state.mime_type != MimeType::MultipartRelated
                            && (mime_type == MimeType::Inline
                                || content_type.is_none_or(|c| !c.has_attribute("name"))));

                // if message consists of single text/plain part, classify as text regardless
                // of encoding issues: see malformed/018.eml
                let is_inline = is_inline
                    || state.parts == 1
                        && state.mime_type == MimeType::Message
                        && mime_type == MimeType::TextPlain
                        && is_encoding_problem;

                let (add_to_html, add_to_text) =
                    if let MimeType::MultipartAlternative = state.mime_type {
                        match mime_type {
                            MimeType::TextHtml => (true, false),
                            MimeType::TextPlain => (false, true),
                            _ => (false, false),
                        }
                    } else if is_inline {
                        if state.in_alternative && (state.need_text_body || state.need_html_body) {
                            match mime_type {
                                MimeType::TextHtml => {
                                    state.need_text_body = false;
                                }
                                MimeType::TextPlain => {
                                    state.need_html_body = false;
                                }
                                _ => (),
                            }
                        }
                        (state.need_html_body, state.need_text_body)
                    } else {
                        (false, false)
                    };

                if add_to_html {
                    message.html_body.push(message.parts.len() as u32);
                }
                if add_to_text {
                    message.text_body.push(message.parts.len() as u32);
                }

                if is_text {
                    let text = match (
                        bytes,
                        content_type.and_then(|ct| {
                            ct.attribute("charset")
                                .and_then(|c| charset_decoder(c.as_bytes()))
                        }),
                    ) {
                        (Cow::Owned(vec), Some(charset_decoder)) => charset_decoder(&vec).into(),
                        (Cow::Owned(vec), None) => String::from_utf8(vec)
                            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
                            .into(),
                        (Cow::Borrowed(bytes), Some(charset_decoder)) => {
                            charset_decoder(bytes).into()
                        }
                        (Cow::Borrowed(bytes), None) => String::from_utf8_lossy(bytes),
                    };

                    let is_html = mime_type == MimeType::TextHtml;

                    if !add_to_html && is_html || !add_to_text && !is_html {
                        message.attachments.push(message.parts.len() as u32);
                    }

                    if is_html {
                        PartType::Html(text)
                    } else {
                        PartType::Text(text)
                    }
                } else {
                    message.attachments.push(message.parts.len() as u32);

                    if !is_inline {
                        PartType::Binary(bytes)
                    } else {
                        PartType::InlineBinary(bytes)
                    }
                }
            } else {
                message.attachments.push(message.parts.len() as u32);

                if depth != 0 {
                    if let Some(nested_message) = self.parse_(bytes.as_ref(), depth - 1, false) {
                        PartType::Message(Message {
                            html_body: nested_message.html_body,
                            text_body: nested_message.text_body,
                            attachments: nested_message.attachments,
                            parts: nested_message
                                .parts
                                .into_iter()
                                .map(|p| p.into_owned())
                                .collect(),
                            raw_message: bytes.into_owned().into(),
                        })
                    } else {
                        is_encoding_problem = true;
                        PartType::Binary(bytes)
                    }
                } else {
                    is_encoding_problem = true;
                    PartType::Binary(bytes)
                }
            };

            // Add part
            message.parts.push(MessagePart {
                headers: std::mem::take(&mut part_headers),
                encoding,
                is_encoding_problem,
                body: body_part,
                offset_header: state.offset_header as u32,
                offset_body: state.offset_body as u32,
                offset_end: state.offset_end as u32,
            });

            if state.mime_boundary.is_some() {
                // Currently processing a MIME part
                'inner: loop {
                    if let MimeType::Message = state.mime_type {
                        // Finished processing a nested message, restore parent message from stack
                        if let Some((mut prev_state, Some(mut prev_message))) = state_stack.pop() {
                            let offset_end = state
                                .mime_boundary
                                .as_ref()
                                .map(|b| {
                                    let pos = stream.offset().saturating_sub(b.len() + 2);
                                    stream.data.get(pos - 2).map_or(pos - 1, |&ch| {
                                        if ch == b'\r' { pos - 2 } else { pos - 1 }
                                    })
                                })
                                .unwrap_or_else(|| stream.offset());
                            message.raw_message = raw_message.into();
                            //raw_message[state.offset_header..offset_end].as_ref().into();

                            if let Some(part) = prev_message.parts.get_mut(state.part_id as usize) {
                                part.offset_end = offset_end as u32;
                                if message.is_empty() {
                                    part.is_encoding_problem = true;
                                    part.body = PartType::Text(String::from_utf8_lossy(
                                        raw_message
                                            .get(part.offset_body as usize..offset_end)
                                            .unwrap_or_default(),
                                    ));
                                } else {
                                    part.body = PartType::Message(message);
                                }
                            } else {
                                debug_assert!(false, "Invalid part ID, could not find message.");
                            }

                            message = prev_message;
                            prev_state.mime_boundary = state.mime_boundary;
                            state = prev_state;
                        } else {
                            debug_assert!(false, "Failed to restore parent message. Aborting.");
                            break 'outer;
                        }
                    }

                    if stream.is_multipart_end() {
                        // End of MIME part reached

                        if MimeType::MultipartAlternative == state.mime_type
                            && state.need_html_body
                            && state.need_text_body
                        {
                            // Found HTML part only
                            if state.text_parts == message.text_body.len()
                                && state.html_parts != message.html_body.len()
                            {
                                for &part_id in &message.html_body[state.html_parts..] {
                                    message.text_body.push(part_id);
                                }
                            }

                            // Found text part only
                            if state.html_parts == message.html_body.len()
                                && state.text_parts != message.text_body.len()
                            {
                                for &part_id in &message.text_body[state.text_parts..] {
                                    message.html_body.push(part_id);
                                }
                            }
                        }

                        if let Some(part) = message.parts.get_mut(state.part_id as usize) {
                            // Add headers and substructure to parent part
                            if state.sub_part_ids.len() != 1 || state.sub_part_ids[0] != 0 {
                                part.body =
                                    PartType::Multipart(std::mem::take(&mut state.sub_part_ids));
                            }

                            // Restore ancestor's state
                            if let Some((prev_state, _)) = state_stack.pop() {
                                state = prev_state;

                                if let Some(ref mime_boundary) = state.mime_boundary {
                                    // Ancestor has a MIME boundary, seek it.
                                    if let Some(offset) =
                                        stream.seek_next_part_offset(mime_boundary)
                                    {
                                        part.offset_end = offset as u32;
                                        continue 'inner;
                                    }
                                }
                            }

                            // This part has no boundary, update end offset
                            part.offset_end = stream.offset() as u32;
                        } else {
                            debug_assert!(false, "Invalid part ID, could not find multipart.");
                        }

                        break 'outer;
                    } else {
                        // Headers of next part expected next, break inner look.
                        break 'inner;
                    }
                }
            } else if stream.offset() >= stream.data.len() {
                break 'outer;
            }
        }

        // Corrupted MIME message, try to recover whatever is possible.
        while let Some((prev_state, prev_message)) = state_stack.pop() {
            if let Some(mut prev_message) = prev_message {
                message.raw_message = raw_message.into(); //raw_message[state.offset_header..stream.offset()].as_ref().into();

                if let Some(part) = prev_message.parts.get_mut(state.part_id as usize) {
                    part.offset_end = stream.offset() as u32;
                    if message.is_empty() {
                        part.is_encoding_problem = true;
                        let raw_text = raw_message.get(part.offset_body as usize..stream.offset());
                        let text = match raw_text
                            .and_then(|bytes| std::str::from_utf8(bytes).ok())
                            .and_then(|text| {
                                state
                                    .mime_boundary
                                    .as_deref()
                                    .and_then(|b| std::str::from_utf8(b).ok())
                                    .and_then(|boundary| {
                                        text.rsplit_once(boundary)
                                            .and_then(|(text, _)| text.strip_suffix("--"))
                                    })
                                    .map(|text| {
                                        let text = text.strip_suffix('\n').unwrap_or(text);
                                        text.strip_suffix('\r').unwrap_or(text)
                                    })
                            }) {
                            Some(text) => Cow::Borrowed(text),
                            _ => String::from_utf8_lossy(raw_text.unwrap_or_default()),
                        };

                        part.body = PartType::Text(text);
                    } else {
                        part.body = PartType::Message(message);
                    }
                } else {
                    debug_assert!(false, "Invalid part ID, could not find message.");
                }

                message = prev_message;
            } else if let Some(part) = message.parts.get_mut(state.part_id as usize) {
                part.offset_end = stream.offset() as u32;
                if state.sub_part_ids.len() != 1 || state.sub_part_ids[0] != 0 {
                    part.body = PartType::Multipart(state.sub_part_ids);
                }
            } else {
                debug_assert!(false, "This should not have happened.");
            }
            state = prev_state;
        }

        message.raw_message = raw_message.into();

        if !message.is_empty() {
            message.parts[0].offset_end = message.raw_message.len() as u32;
            Some(message)
        } else if !part_headers.is_empty() {
            // Message without a body
            message.parts.push(MessagePart {
                headers: part_headers,
                encoding: Encoding::None,
                is_encoding_problem: true,
                body: PartType::Text("".into()),
                offset_header: 0,
                offset_body: message.raw_message.len() as u32,
                offset_end: message.raw_message.len() as u32,
            });
            Some(message)
        } else {
            None
        }
    }
}

impl<'x> Message<'x> {
    fn new() -> Message<'x> {
        Message {
            ..Default::default()
        }
    }

    /// Returns `false` if at least one header field was successfully parsed.
    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use crate::MessageParser;

    #[test]
    fn parse_full_messages() {
        for test_suite in ["rfc", "legacy", "thirdparty", "malformed"] {
            let test_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("eml")
                .join(test_suite);

            let mut tests_run = 0;

            for file_name in fs::read_dir(&test_dir).unwrap() {
                let mut file_name = file_name.unwrap().path();
                if file_name.extension().is_some_and(|e| e == "eml") {
                    let raw_original = fs::read(&file_name).unwrap();
                    tests_run += 1;

                    // Test without CRs
                    let raw_message = strip_crlf(&raw_original);
                    file_name.set_extension("json");
                    let expected_result = fs::read(&file_name).unwrap();

                    let message = MessageParser::default().parse(&raw_message).unwrap();
                    let json_message = serde_json::to_string_pretty(&message).unwrap();

                    // Test that deserialization also works
                    let _: super::Message<'_> = serde_json::from_str(&json_message).unwrap();

                    if json_message.as_bytes() != expected_result {
                        file_name.set_extension("failed");
                        fs::write(&file_name, json_message.as_bytes()).unwrap();
                        panic!(
                            "Test failed, parsed message saved to {}",
                            file_name.display()
                        );
                    }

                    // Test with CRs
                    let raw_message = add_crlf(&raw_original);
                    file_name.set_extension("crlf.json");
                    let expected_result = fs::read(&file_name).unwrap();

                    let message = MessageParser::default().parse(&raw_message).unwrap();
                    let json_message = serde_json::to_string_pretty(&message).unwrap();

                    if json_message.as_bytes() != expected_result {
                        file_name.set_extension("failed");
                        fs::write(&file_name, json_message.as_bytes()).unwrap();
                        panic!(
                            "Test failed, parsed message saved to {}",
                            file_name.display()
                        );
                    }
                }
            }

            assert!(
                tests_run > 0,
                "Did not find any tests to run in folder {}.",
                test_dir.display()
            );
        }
    }

    fn add_crlf(bytes: &[u8]) -> Vec<u8> {
        let mut result = Vec::with_capacity(bytes.len());
        let mut last_ch = 0;
        for &ch in bytes {
            if ch == b'\n' && last_ch != b'\r' {
                result.push(b'\r');
            }
            result.push(ch);
            last_ch = ch;
        }

        result
    }

    fn strip_crlf(bytes: &[u8]) -> Vec<u8> {
        let mut result = Vec::with_capacity(bytes.len());
        for &ch in bytes {
            if ch != b'\r' {
                result.push(ch);
            }
        }

        result
    }
}
