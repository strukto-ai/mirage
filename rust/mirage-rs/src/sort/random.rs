use std::cmp::Ordering;

use blake2::Blake2b;
use blake2::digest::Digest;
use blake2::digest::consts::U16;

use super::modifiers::{Mods, TRANSLATED_BLOCK, translate};

#[derive(Default)]
enum Phase {
    #[default]
    Salt,
    Left,
    Right,
}

#[derive(Default)]
pub(super) struct RandomScan {
    phase: Phase,
    at: usize,
    salted: Blake2b<U16>,
    hasher: Blake2b<U16>,
    left: [u8; 16],
}

impl RandomScan {
    pub(super) fn step(
        &mut self,
        a: &[u8],
        b: &[u8],
        salt: &[u8],
        mods: &Mods,
        bytes: &mut usize,
    ) -> Option<Ordering> {
        loop {
            let source = match self.phase {
                Phase::Salt => salt,
                Phase::Left => a,
                Phase::Right => b,
            };
            if self.at < source.len() {
                if *bytes == 0 {
                    return None;
                }
                let transformed = !matches!(self.phase, Phase::Salt)
                    && (mods.fold || mods.dictionary || mods.ignore_nonprinting);
                let count = if transformed {
                    (*bytes).min(TRANSLATED_BLOCK)
                } else {
                    *bytes
                };
                let end = source.len().min(self.at.saturating_add(count));
                let part = &source[self.at..end];
                if transformed {
                    let mut buffer = [0; TRANSLATED_BLOCK];
                    let length = translate(part, mods, &mut buffer);
                    self.hasher.update(&buffer[..length]);
                } else {
                    self.hasher.update(part);
                }
                *bytes -= end - self.at;
                self.at = end;
                continue;
            }
            self.at = 0;
            match self.phase {
                Phase::Salt => {
                    self.salted = self.hasher.clone();
                    self.phase = Phase::Left;
                }
                Phase::Left => {
                    self.left = std::mem::replace(&mut self.hasher, self.salted.clone())
                        .finalize()
                        .into();
                    self.phase = Phase::Right;
                }
                Phase::Right => {
                    let right: [u8; 16] = std::mem::take(&mut self.hasher).finalize().into();
                    return Some(self.left.cmp(&right));
                }
            }
        }
    }
}
