/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{AttachmentIterator, BodyPartIterator, Message, MessagePart, MessagePartId, PartType};

impl PartType<'_> {
    #[allow(clippy::len_without_is_empty)]
    pub fn len(&self) -> usize {
        match self {
            PartType::Text(v) | PartType::Html(v) => v.len(),
            PartType::Binary(v) | PartType::InlineBinary(v) => v.len(),
            PartType::Message(v) => v.raw_message.len(),
            PartType::Multipart(_) => 0,
        }
    }
}

impl<'x> BodyPartIterator<'x> {
    pub(crate) fn new(message: &'x Message<'x>, list: &'x [MessagePartId]) -> BodyPartIterator<'x> {
        BodyPartIterator {
            message,
            list,
            pos: -1,
        }
    }
}

impl<'x> Iterator for BodyPartIterator<'x> {
    type Item = &'x MessagePart<'x>;

    fn next(&mut self) -> Option<Self::Item> {
        self.pos += 1;
        self.message
            .parts
            .get(*self.list.get(self.pos as usize)? as usize)
    }
}

impl<'x> AttachmentIterator<'x> {
    pub(crate) fn new(message: &'x Message<'x>) -> AttachmentIterator<'x> {
        AttachmentIterator { message, pos: -1 }
    }
}

impl<'x> Iterator for AttachmentIterator<'x> {
    type Item = &'x MessagePart<'x>;

    fn next(&mut self) -> Option<Self::Item> {
        self.pos += 1;
        self.message.attachment(self.pos as u32)
    }
}
