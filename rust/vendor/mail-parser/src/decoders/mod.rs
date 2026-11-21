/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::parsers::MessageStream;

pub mod base64;
pub mod charsets;
pub mod encoded_word;
pub mod hex;
pub mod html;
pub mod quoted_printable;

pub type DecodeFnc<'x> = fn(&mut MessageStream<'x>, &[u8]) -> (usize, Cow<'x, [u8]>);
pub type DecodeWordFnc<'x> = fn(&mut MessageStream<'x>) -> Option<Vec<u8>>;
