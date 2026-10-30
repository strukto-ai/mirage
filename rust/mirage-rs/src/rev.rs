use crate::records::{Records, Take};
use crate::{Stream, StreamError};

pub(crate) fn open(_config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Rev {
        records: Records::default(),
    }))
}

/// util-linux rev: each line's characters in reverse order, its newline
/// kept where it was. A byte that is no part of a UTF-8 character reads
/// as U+FFFD, one per maximal invalid run, as the hosts always decoded it.
struct Rev {
    /// The start of a line the input has not ended yet.
    records: Records,
}

fn reversed(line: &[u8], out: &mut Vec<u8>) {
    if line.is_ascii() {
        out.extend(line.iter().rev());
        return;
    }
    let mut buf = [0; 4];
    for c in String::from_utf8_lossy(line).chars().rev() {
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
}

impl Rev {
    fn pump(&mut self, out: &mut Vec<u8>) {
        while let Take::Record((line, terminated)) = self.records.peek_span(b'\n') {
            reversed(line, out);
            if terminated {
                out.push(b'\n');
            }
            self.records.advance();
        }
    }
}

impl Stream for Rev {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.push(input);
        self.pump(out);
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.end();
        self.pump(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    #[test]
    fn each_line_reverses_by_character() {
        let chunks: [&[u8]; 3] = [b"abc\nh\xc3", b"\xa9llo\n\n", b"no newline"];
        assert_eq!(
            run("rev", "{}", &chunks).0,
            b"cba\noll\xc3\xa9h\n\nenilwen on"
        );
        assert_eq!(
            run("rev", "{}", &[b"a\xffb\xe2\x82\n"]).0,
            "\u{FFFD}b\u{FFFD}a\n".as_bytes()
        );
    }
}
