/// What an input gives when asked for its next record.
pub(crate) enum Take {
    Record(Vec<u8>),
    End,
    Wait,
}

/// The bytes an input has delivered, read back a record at a time: a
/// record ends at its terminator, and the last one at the end of input.
#[derive(Default)]
pub(crate) struct Records {
    buf: Vec<u8>,
    pos: usize,
    searched: usize,
    ended: bool,
}

impl Records {
    pub(crate) fn push(&mut self, data: &[u8]) {
        if self.pos * 2 > self.buf.len() {
            self.buf.drain(..self.pos);
            self.searched -= self.pos;
            self.pos = 0;
        }
        self.buf.extend_from_slice(data);
    }

    pub(crate) fn end(&mut self) {
        self.ended = true;
    }

    pub(crate) fn ended(&self) -> bool {
        self.ended
    }

    pub(crate) fn next(&mut self, terminator: u8) -> Take {
        let from = self.searched.max(self.pos);
        let end = match memchr::memchr(terminator, &self.buf[from..]) {
            Some(at) => from + at,
            None if self.ended && self.pos < self.buf.len() => self.buf.len(),
            None if self.ended => return Take::End,
            None => {
                self.searched = self.buf.len();
                return Take::Wait;
            }
        };
        let record = self.buf[self.pos..end].to_vec();
        self.pos = (end + 1).min(self.buf.len());
        self.searched = self.pos;
        Take::Record(record)
    }
}
