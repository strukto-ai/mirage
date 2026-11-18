use serde_json::{Map, Value};
use std::io::{self, Read, Write};

/// The protocol version a host and a client must share.
pub const PROTOCOL: u64 = 1;

/// The largest frame either side accepts.
pub const MAX_FRAME: usize = 64 << 20;

/// One fsproto frame: a big-endian u32 length, then a big-endian u32 header
/// length, a JSON object header and the raw body. A request from the machine
/// carries an `id` its reply echoes; a request of the host's carries an `hid`.
#[derive(Debug, Default)]
pub struct Frame {
    pub head: Map<String, Value>,
    pub body: Vec<u8>,
}

impl Frame {
    #[cfg(test)]
    pub fn new(head: Value, body: Vec<u8>) -> Frame {
        match head {
            Value::Object(head) => Frame { head, body },
            _ => Frame {
                head: Map::new(),
                body,
            },
        }
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.head.get(key).and_then(Value::as_str)
    }

    pub fn u64(&self, key: &str) -> Option<u64> {
        self.head.get(key).and_then(Value::as_u64)
    }
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("fsproto: {what}"))
}

/// The next frame on `input`, or None once it ends between frames.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut size = [0u8; 4];
    match input.read_exact(&mut size) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let total = u32::from_be_bytes(size) as usize;
    if !(4..=MAX_FRAME).contains(&total) {
        return Err(invalid("a frame of impossible size"));
    }
    let mut buf = vec![0u8; total];
    input.read_exact(&mut buf)?;
    let head_len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if 4 + head_len > total {
        return Err(invalid("a header past its frame"));
    }
    let head = match serde_json::from_slice::<Value>(&buf[4..4 + head_len]) {
        Ok(Value::Object(head)) => head,
        Ok(_) => return Err(invalid("a header that is not an object")),
        Err(err) => return Err(invalid(&err.to_string())),
    };
    let body = buf.split_off(4 + head_len);
    Ok(Some(Frame { head, body }))
}

/// `head` and `body` as one frame's bytes.
pub fn encode(head: &Map<String, Value>, body: &[u8]) -> Vec<u8> {
    let head = serde_json::to_vec(head).unwrap_or_else(|_| b"{}".to_vec());
    let total = 4 + head.len() + body.len();
    let mut out = Vec::with_capacity(4 + total);
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(&(head.len() as u32).to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(body);
    out
}

/// Write one frame and flush it.
pub fn write_frame(
    output: &mut impl Write,
    head: &Map<String, Value>,
    body: &[u8],
) -> io::Result<()> {
    output.write_all(&encode(head, body))?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_frame_reads_back_as_written() {
        let Value::Object(head) = json!({"id": 7, "op": "getattr", "path": "/w/a b"}) else {
            unreachable!()
        };
        let bytes = encode(&head, b"\x00\x01body");
        let frame = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(frame.u64("id"), Some(7));
        assert_eq!(frame.str("path"), Some("/w/a b"));
        assert_eq!(frame.body, b"\x00\x01body");
    }

    // The bytes the TypeScript and Python hosts' tests decode too.
    #[test]
    fn a_frame_has_the_shared_layout() {
        let Value::Object(head) = json!({"id": 1}) else {
            unreachable!()
        };
        assert_eq!(
            encode(&head, b"xy"),
            b"\x00\x00\x00\x0e\x00\x00\x00\x08{\"id\":1}xy"
        );
    }

    #[test]
    fn input_that_ends_between_frames_is_the_end() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
    }

    #[test]
    fn a_header_past_its_frame_is_refused() {
        let bytes = b"\x00\x00\x00\x06\x00\x00\x00\x09{}";
        assert!(read_frame(&mut bytes.as_slice()).is_err());
    }
}
