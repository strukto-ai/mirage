use std::collections::BTreeMap;

pub(super) const STEP: usize = 16 * 1024;

#[derive(Default)]
pub(super) struct Input {
    pub(super) pages: BTreeMap<usize, Vec<u8>>,
    pub(super) len: usize,
}

impl Input {
    pub(super) fn push(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let n = bytes.len().min(STEP - self.len % STEP);
            if self.len % STEP == 0 {
                self.pages.insert(self.len / STEP, Vec::with_capacity(n));
            }
            self.pages
                .get_mut(&(self.len / STEP))
                .expect("input page")
                .extend_from_slice(&bytes[..n]);
            self.len += n;
            bytes = &bytes[n..];
        }
    }

    pub(super) fn get(&self, at: usize) -> Option<u8> {
        (at < self.len).then(|| self.pages[&(at / STEP)][at % STEP])
    }

    pub(super) fn copy(&self, at: usize, n: usize, out: &mut Vec<u8>) -> usize {
        let n = n.min(self.len - at).min(STEP - at % STEP);
        if n != 0 {
            out.extend_from_slice(&self.pages[&(at / STEP)][at % STEP..at % STEP + n]);
        }
        n
    }
}

pub(super) fn hex(byte: u8) -> Option<u32> {
    (byte as char).to_digit(16)
}
