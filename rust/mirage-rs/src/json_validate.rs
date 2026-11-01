use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let _: Config = parse_config(config)?;
    Ok(Box::new(Validate(Some(Vec::new()))))
}

struct Validate(Option<Vec<u8>>);

impl Stream for Validate {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(raw) = &mut self.0 {
            raw.extend_from_slice(input);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(raw) = self.0.take()
            && let Err(error) = serde_json::from_slice::<serde_json::Value>(&raw)
        {
            out.extend_from_slice(error.to_string().as_bytes());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::open;

    #[test]
    fn validates_across_chunks_and_finishes_once() {
        for (raw, expected) in [
            (&b"{\"a\":1}"[..], ""),
            (&b""[..], "EOF while parsing a value at line 1 column 0"),
            (
                &b"[\"\xc3\xa9\"x"[..],
                "expected `,` or `]` at line 1 column 6",
            ),
            (&b"1e999"[..], "number out of range at line 1 column 5"),
            (
                &b"\"\\udc00\""[..],
                "lone leading surrogate in hex escape at line 1 column 7",
            ),
        ] {
            let mut stream = open("json_validate", b"{}").unwrap();
            let mut out = Vec::new();
            for chunk in raw.chunks(1) {
                stream.feed(chunk, &mut out).unwrap();
            }
            assert!(out.is_empty());
            stream.finish(&mut out).unwrap();
            stream.finish(&mut out).unwrap();
            assert_eq!(out, expected.as_bytes());
        }
        assert!(open("json_validate", br#"{"unknown":true}"#).is_err());
    }
}
