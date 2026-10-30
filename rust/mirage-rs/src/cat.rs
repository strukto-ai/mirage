use serde::Deserialize;

use crate::{Stream, StreamError};

const WORK: usize = 16 * 1024;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    number_lines: bool,
    number_nonblank: bool,
    show_ends: bool,
    squeeze_blank: bool,
    show_tabs: bool,
    show_nonprinting: bool,
}

struct Cat {
    config: Config,
    input: Vec<u8>,
    position: usize,
    line: u64,
    start: bool,
    blank: bool,
    cr: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Cat {
        config: crate::parse_config(config)?,
        input: Vec::new(),
        position: 0,
        line: 0,
        start: true,
        blank: false,
        cr: false,
    }))
}

impl Cat {
    fn step(&mut self, out: &mut Vec<u8>) {
        let end = self.input.len().min(self.position.saturating_add(WORK));
        for &byte in &self.input[self.position..end] {
            if self.cr {
                out.extend_from_slice(if byte == b'\n' { b"^M" } else { b"\r" });
                self.cr = false;
            }
            if self.start {
                if byte == b'\n' && self.config.squeeze_blank && self.blank {
                    continue;
                }
                if (self.config.number_lines && !self.config.number_nonblank)
                    || (self.config.number_nonblank && byte != b'\n')
                {
                    self.line = self.line.saturating_add(1);
                    out.extend_from_slice(format!("{:6}\t", self.line).as_bytes());
                }
            }
            if byte == b'\n' {
                self.blank = self.start;
                self.start = true;
                if self.config.show_ends {
                    out.push(b'$');
                }
                out.push(byte);
                continue;
            }
            self.start = false;
            self.blank = false;
            if byte == b'\t' {
                out.extend_from_slice(if self.config.show_tabs { b"^I" } else { b"\t" });
            } else if self.config.show_nonprinting {
                let low = if byte >= 128 {
                    out.extend_from_slice(b"M-");
                    byte - 128
                } else {
                    byte
                };
                if low < 32 {
                    out.extend_from_slice(&[b'^', low + 64]);
                } else if low == 127 {
                    out.extend_from_slice(b"^?");
                } else {
                    out.push(low);
                }
            } else if byte == b'\r' && self.config.show_ends {
                self.cr = true;
            } else {
                out.push(byte);
            }
        }
        self.position = end;
        if end == self.input.len() {
            self.input.clear();
            self.position = 0;
        }
    }
}

impl Stream for Cat {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.input.extend_from_slice(input);
        self.step(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.cr {
            out.push(b'\r');
            self.cr = false;
        }
        Ok(())
    }

    fn busy(&self) -> bool {
        !self.input.is_empty()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    #[test]
    fn display_survives_every_chunk_boundary() {
        let data = b"\n\n\ta\0\x7f\x80\x89\xff\r\n\n\nlast\r";
        for split in 0..=data.len() {
            assert_eq!(
                run("cat", r#"{"number_lines":true,"number_nonblank":true,"show_ends":true,"show_tabs":true,"show_nonprinting":true,"squeeze_blank":true}"#, &[&data[..split], &data[split..]]).0,
                b"$\n     1\t^Ia^@^?M-^@M-^IM-^?^M$\n$\n     2\tlast^M"
            );
            assert_eq!(
                run(
                    "cat",
                    r#"{"show_ends":true}"#,
                    &[&data[..split], &data[split..]]
                )
                .0,
                b"$\n$\n\ta\0\x7f\x80\x89\xff^M$\n$\n$\nlast\r"
            );
        }
    }

    #[test]
    fn long_unterminated_input_drains_in_bounded_steps() {
        let mut stream = crate::open("cat", br#"{"show_nonprinting":true}"#).unwrap();
        let mut out = Vec::new();
        stream.feed(&vec![255; super::WORK * 3], &mut out).unwrap();
        assert_eq!(out.len(), super::WORK * 4);
        assert!(stream.busy());
        let mut total = out.len();
        while stream.busy() {
            out.clear();
            stream.drain(&mut out).unwrap();
            assert!(out.len() <= super::WORK * 4);
            total += out.len();
        }
        assert_eq!(total, super::WORK * 12);
    }
}
