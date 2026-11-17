use mirage_rs::{Stream, StreamError};

mod nfs;
mod streams;

fn open_stream(kind: &str, config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    mirage_rs::open(kind, config)
}
