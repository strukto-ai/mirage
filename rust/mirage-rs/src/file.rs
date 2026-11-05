use serde::Deserialize;

use crate::{Stream, StreamError, latin1_opt, parse_config};

const SIGNATURES: &[(&[u8], &[u8])] = &[
    (b"\x89PNG", b"image/png"),
    (b"\xff\xd8\xff", b"image/jpeg"),
    (b"GIF8", b"image/gif"),
    (b"PK\x03\x04", b"application/zip"),
    (b"\x1f\x8b", b"application/gzip"),
    (b"%PDF", b"application/pdf"),
    (b"{\n", b"json"),
    (b"[{", b"json"),
];

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "latin1_opt")]
    kind: Option<Vec<u8>>,
    mime: bool,
}

struct File {
    config: Config,
    header: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(File {
        config: parse_config(config)?,
        header: Vec::new(),
    }))
}

impl File {
    fn detected(&self) -> &[u8] {
        if let Some(kind) = &self.config.kind {
            return kind;
        }
        SIGNATURES
            .iter()
            .find_map(|(signature, kind)| self.header.starts_with(signature).then_some(*kind))
            .unwrap_or_else(|| {
                if self.header.iter().take(256).all(|&byte| byte < 128) {
                    b"text"
                } else {
                    b"binary"
                }
            })
    }
}

impl Stream for File {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.header
            .extend_from_slice(&input[..input.len().min(256 - self.header.len())]);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let kind = self.detected();
        let shown: &[u8] = if self.config.mime {
            match kind {
                b"text" => b"text/plain; charset=us-ascii",
                b"json" => b"application/json; charset=us-ascii",
                b"csv" => b"text/csv; charset=us-ascii",
                b"directory" => b"inode/directory",
                b"binary" => b"application/octet-stream",
                other => other,
            }
        } else {
            kind
        };
        out.extend_from_slice(shown);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    #[test]
    fn signatures_survive_every_input_boundary() {
        for &(signature, kind) in super::SIGNATURES {
            for cut in 0..=signature.len() {
                let (output, error) = run("file", "{}", &[&signature[..cut], &signature[cut..]]);
                assert_eq!(error, None);
                assert_eq!(output, kind);
            }
        }
    }

    #[test]
    fn only_the_first_256_bytes_affect_the_ascii_probe() {
        assert_eq!(run("file", "{}", &[&[0; 512]]).0, b"text");
        let mut bytes = vec![0; 257];
        bytes[256] = 255;
        assert_eq!(run("file", "{}", &[&bytes]).0, b"text");
        bytes[255] = 255;
        assert_eq!(run("file", "{}", &[&bytes]).0, b"binary");
    }

    #[test]
    fn metadata_and_mime_use_the_same_catalog() {
        assert_eq!(
            run("file", r#"{"kind":"csv","mime":true}"#, &[]).0,
            b"text/csv; charset=us-ascii"
        );
        assert_eq!(
            run("file", r#"{"kind":"directory","mime":true}"#, &[]).0,
            b"inode/directory"
        );
        assert_eq!(run("file", r#"{"kind":"custom"}"#, &[b"%PDF"]).0, b"custom");
        assert_eq!(
            run("file", r#"{"kind":"\u00ff","mime":true}"#, &[]).0,
            b"\xff"
        );
    }
}
