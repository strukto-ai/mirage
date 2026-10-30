/// What an input gives when asked for its next record.
pub(crate) enum Take<T = Vec<u8>> {
    Record(T),
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
    ready: Option<(usize, bool)>,
}

impl Records {
    fn compact(&mut self) {
        if self.pos * 2 > self.buf.len() {
            self.buf.drain(..self.pos);
            self.searched -= self.pos;
            if let Some((end, _)) = &mut self.ready {
                *end -= self.pos;
            }
            self.pos = 0;
            crate::release_capacity(&mut self.buf);
        }
    }

    pub(crate) fn push(&mut self, data: &[u8]) {
        self.compact();
        self.buf.extend_from_slice(data);
    }

    pub(crate) fn end(&mut self) {
        self.ended = true;
    }

    pub(crate) fn ended(&self) -> bool {
        self.ended
    }

    pub(crate) fn next(&mut self, terminator: u8) -> Take {
        match self.next_span(terminator) {
            Take::Record(record) => Take::Record(record.to_vec()),
            Take::End => Take::End,
            Take::Wait => Take::Wait,
        }
    }

    pub(crate) fn peek_span(&mut self, terminator: u8) -> Take<(&[u8], bool)> {
        self.compact();
        if self.ready.is_none() {
            let from = self.searched.max(self.pos);
            let (end, terminated) = match memchr::memchr(terminator, &self.buf[from..]) {
                Some(at) => (from + at, true),
                None if self.ended && self.pos < self.buf.len() => (self.buf.len(), false),
                None if self.ended => return Take::End,
                None => {
                    self.searched = self.buf.len();
                    return Take::Wait;
                }
            };
            self.ready = Some((end, terminated));
        }
        let (end, terminated) = self.ready.unwrap();
        Take::Record((&self.buf[self.pos..end], terminated))
    }

    pub(crate) fn advance(&mut self) {
        if let Some((end, terminated)) = self.ready.take() {
            self.pos = end + usize::from(terminated);
            self.searched = self.pos;
        }
    }

    pub(crate) fn next_span(&mut self, terminator: u8) -> Take<&[u8]> {
        match self.peek_span(terminator) {
            Take::Wait => return Take::Wait,
            Take::End => return Take::End,
            Take::Record(_) => {}
        }
        let start = self.pos;
        let (end, _) = self.ready.unwrap();
        self.advance();
        Take::Record(&self.buf[start..end])
    }
}
