use crate::{Stream, StreamError};

pub(crate) fn open(_config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Rev { held: Vec::new() }))
}

/// util-linux rev: each line's characters in reverse order, its newline
/// kept where it was. A byte that is no part of a UTF-8 character reads
/// as U+FFFD, one per maximal invalid run, as the hosts always decoded it.
struct Rev {
    /// The start of a line the input has not ended yet.
    held: Vec<u8>,
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

impl Stream for Rev {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while let Some(at) = memchr::memchr(b'\n', rest) {
            if self.held.is_empty() {
                reversed(&rest[..at], out);
            } else {
                self.held.extend_from_slice(&rest[..at]);
                reversed(&self.held, out);
                self.held.clear();
            }
            out.push(b'\n');
            rest = &rest[at + 1..];
        }
        self.held.extend_from_slice(rest);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        reversed(&self.held, out);
        self.held.clear();
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
