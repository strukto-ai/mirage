use crate::constants::MAX_HELD;

/// What an input gives when asked for its next record.
pub(crate) enum Take<T = Vec<u8>> {
    Record(T),
    End,
    Wait,
}

/// The most the buffer grows to by doubling: a record at the cap and the
/// chunks past it fit, short of the 2 GiB a byte vector on wasm32 cannot
/// hold.
const GROW_LIMIT: usize = MAX_HELD + MAX_HELD / 2;

/// A record passed `MAX_HELD` with no terminator.
#[derive(Debug)]
pub(crate) struct Overlong;

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
            self.drain_read();
            crate::release_capacity(&mut self.buf);
        }
    }

    /// Take the next bytes, refused once the record they would extend has
    /// been searched past `MAX_HELD` with no terminator. Room is made by
    /// dropping what was read first, then by doubling up to `GROW_LIMIT`.
    pub(crate) fn push(&mut self, data: &[u8]) -> Result<(), Overlong> {
        self.compact();
        if self.searched.saturating_sub(self.pos) > MAX_HELD {
            return Err(Overlong);
        }
        if self.buf.len() + data.len() > self.buf.capacity() {
            self.drain_read();
        }
        let needed = self.buf.len() + data.len();
        if needed > self.buf.capacity() {
            let doubled = self.buf.capacity().saturating_mul(2).min(GROW_LIMIT);
            self.buf.reserve_exact(needed.max(doubled) - self.buf.len());
        }
        self.buf.extend_from_slice(data);
        Ok(())
    }

    fn drain_read(&mut self) {
        self.buf.drain(..self.pos);
        self.searched -= self.pos;
        if let Some((end, _)) = &mut self.ready {
            *end -= self.pos;
        }
        self.pos = 0;
    }

    pub(crate) fn end(&mut self) {
        self.ended = true;
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

    /// As much of the current record as has come, at most `max` bytes, and
    /// whether its terminator ends it there, so a record is never held
    /// whole. End comes only between records; a record the input's end
    /// cuts off is followed by End.
    pub(crate) fn piece(&mut self, terminator: u8, max: usize) -> Take<(&[u8], bool)> {
        self.compact();
        let start = self.pos;
        let end = self.buf.len().min(start.saturating_add(max.max(1)));
        if start == end {
            return if self.ended { Take::End } else { Take::Wait };
        }
        let (stop, done) = match memchr::memchr(terminator, &self.buf[start..end]) {
            Some(at) => (start + at, true),
            None => (end, false),
        };
        self.pos = stop + usize::from(done);
        self.searched = self.pos;
        Take::Record((&self.buf[start..stop], done))
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

#[cfg(test)]
mod tests {
    use super::{GROW_LIMIT, MAX_HELD, Records, Take};
    use crate::{StreamError, open};

    #[test]
    fn a_record_searched_past_the_cap_takes_no_more_and_never_doubles_past_the_limit() {
        let mut records = Records::default();
        records.push(b"a\nb").unwrap();
        assert!(matches!(records.next_span(b'\n'), Take::Record(b"a")));
        let refused = loop {
            assert!(matches!(records.peek_span(b'\n'), Take::Wait));
            if records.push(&[b'x'; 1000]).is_err() {
                break records.buf.len();
            }
            assert!(records.buf.capacity() <= GROW_LIMIT);
        };
        assert!(refused > MAX_HELD && refused <= MAX_HELD + 1000);
        let long = vec![b'x'; MAX_HELD + 1];
        let mut pieces = Records::default();
        for _ in 0..3 {
            pieces.push(&long).unwrap();
            let Take::Record((piece, false)) = pieces.piece(b'\n', usize::MAX) else {
                panic!("a piece of an open record");
            };
            assert_eq!(piece.len(), long.len());
        }
    }

    #[test]
    fn pieces_stop_at_the_terminator_and_the_window() {
        let mut records = Records::default();
        records.push(b"abc\nd").unwrap();
        let mut seen = Vec::new();
        loop {
            match records.piece(b'\n', 2) {
                Take::Record((piece, done)) => seen.push((piece.to_vec(), done)),
                Take::Wait => break,
                Take::End => unreachable!(),
            }
        }
        let expected: [(&[u8], bool); 3] = [(b"ab", false), (b"c", true), (b"d", false)];
        assert_eq!(seen, expected.map(|(piece, done)| (piece.to_vec(), done)));
        records.end();
        assert!(matches!(records.piece(b'\n', 2), Take::End));
    }

    /// An engine, its configuration and inputs, and what it writes before
    /// the long line.
    type Case<'a> = (&'a str, &'a str, Vec<&'a [u8]>, &'a [u8]);

    /// Feed each input in 1000-byte chunks as the stream asks, until it
    /// refuses: what it wrote first, and the refusal.
    fn refused(kind: &str, config: &str, inputs: &[&[u8]]) -> (Vec<u8>, StreamError) {
        let mut stream = open(kind, config.as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut at = vec![0; inputs.len()];
        loop {
            let index = stream.wants().unwrap_or(0);
            let input = inputs[index];
            let result = if stream.busy() {
                stream.drain(&mut out)
            } else if at[index] == input.len() {
                assert!(inputs.len() > 1, "{kind} took the whole line");
                stream.end_input(index, &mut out)
            } else {
                let end = input.len().min(at[index] + 1000);
                let chunk = &input[at[index]..end];
                at[index] = end;
                stream.feed_input(index, chunk, &mut out)
            };
            if let Err(err) = result {
                return (out, err);
            }
        }
    }

    #[test]
    fn whole_record_engines_refuse_a_line_past_the_cap_in_their_own_words() {
        let line = |first: &[u8]| [first, &vec![b'x'; MAX_HELD + 2000]].concat();
        let (letter, digit) = (line(b"a\n"), line(b"1\n"));
        let pair: &[u8] = b"a\nb\n";
        let comm = r#"{"suppress":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"zero_terminated":false,"shared":false,"stdin_twice":false}"#;
        let join = r#"{"keys":[0,0],"unpaired":[false,false],"paired":true,"filler":null,"columns":[],"auto_columns":false,"delimiter":null,"separator":" ","fold_case":false,"zero_terminated":false,"order":"warn","header":false,"names":["a","b"]}"#;
        let uniq = r#"{"count":false,"repeated":false,"unique":false,"typed":[],"ignore_case":false,"all_repeated":null,"group":null,"zero_terminated":false}"#;
        let nl = r#"{"options":[],"separator":"\t","delimiter":"\\:","no_renumber":false,"utf8":false,"inputs":1}"#;
        let sort = r#"{"mode":"check","compare":{"keys":[],"field_sep":null,"reverse":false,"unique":false,"stable":false},"zero_terminated":false}"#;
        let numfmt = r#"{"to":"si","from":"none","suffix":"","operands":[]}"#;
        let digest = r#"{"algorithm":"md5","check_lines":true}"#;
        let listed: &[u8] = b"{\"line\":1,\"parsed\":null}\n";
        let cases: [Case; 9] = [
            ("uniq", uniq, vec![&letter], b"a\n"),
            ("comm", comm, vec![&letter, pair], b"\t\ta\n"),
            ("comm", comm, vec![pair, &letter], b"\t\ta\n"),
            ("join", join, vec![&letter, pair], b""),
            ("nl", nl, vec![&letter], b"     1\ta\n"),
            ("rev", "{}", vec![&letter], b"a\n"),
            ("sort", sort, vec![&letter], b""),
            ("numfmt", numfmt, vec![&digit], b"1\n"),
            ("digest", digest, vec![&letter], listed),
        ];
        for (kind, config, inputs, written) in cases {
            let message = match kind {
                "rev" => "rev: cannot allocate 4 bytes: Cannot allocate memory".to_owned(),
                "numfmt" => "numfmt: error reading input: Cannot allocate memory".to_owned(),
                "digest" => "read error".to_owned(),
                _ => format!("{kind}: memory exhausted"),
            };
            let status = if kind == "sort" { 2 } else { 1 };
            let (out, err) = refused(kind, config, &inputs);
            assert_eq!(
                (out.as_slice(), err.message, err.status),
                (written, message, status),
                "{kind}"
            );
        }
    }
}
