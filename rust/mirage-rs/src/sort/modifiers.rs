use serde::{Deserialize, Serialize};

use crate::number::is_blank;

/// One key's ordering options.
#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Mods {
    pub numeric: bool,
    pub general_numeric: bool,
    pub human: bool,
    pub version: bool,
    pub month: bool,
    pub fold: bool,
    pub reverse: bool,
    pub dictionary: bool,
    pub ignore_nonprinting: bool,
    /// `-R`: the key's salted hash orders it, so equal keys stay together.
    pub random: bool,
}

/// The bytes `-d` keeps (alphanumerics and blanks) and `-i` keeps
/// (printable ASCII) in the C locale.
pub(super) fn kept(byte: u8, mods: &Mods) -> bool {
    if mods.dictionary {
        byte.is_ascii_alphanumeric() || is_blank(byte)
    } else if mods.ignore_nonprinting {
        (0x20..0x7F).contains(&byte)
    } else {
        true
    }
}

pub(super) const TRANSLATED_BLOCK: usize = 4096;

pub(super) fn translate(source: &[u8], mods: &Mods, output: &mut [u8]) -> usize {
    let mut length = 0;
    for byte in source.iter().copied().filter(|&byte| kept(byte, mods)) {
        output[length] = if mods.fold {
            byte.to_ascii_uppercase()
        } else {
            byte
        };
        length += 1;
    }
    length
}

pub(super) struct Translated {
    at: usize,
    buffer: [u8; TRANSLATED_BLOCK],
    start: usize,
    end: usize,
}

impl Default for Translated {
    fn default() -> Self {
        Self {
            at: 0,
            buffer: [0; TRANSLATED_BLOCK],
            start: 0,
            end: 0,
        }
    }
}

impl Translated {
    pub(super) fn fill(&mut self, source: &[u8], mods: &Mods, bytes: &mut usize) -> Option<()> {
        while self.start == self.end && self.at < source.len() {
            if *bytes == 0 {
                return None;
            }
            let end = source
                .len()
                .min(self.at.saturating_add((*bytes).min(TRANSLATED_BLOCK)));
            self.start = 0;
            self.end = translate(&source[self.at..end], mods, &mut self.buffer);
            *bytes -= end - self.at;
            self.at = end;
        }
        Some(())
    }

    pub(super) fn remaining(&self) -> &[u8] {
        &self.buffer[self.start..self.end]
    }

    pub(super) fn advance(&mut self, count: usize) {
        self.start += count;
    }
}
