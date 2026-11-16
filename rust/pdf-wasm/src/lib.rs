//! The streams' Wasm exports over pdftotext and pdfinfo alone, kept out of
//! the main module so that one stays under the browser's compile limit.

use mirage_rs::{Stream, StreamError};

#[path = "../../wasm/src/streams.rs"]
mod streams;

fn open_stream(kind: &str, config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    match kind {
        "pdftotext" => mirage_rs::cli::pdf::open_text(config),
        "pdfinfo" => mirage_rs::cli::pdf::open_info(config),
        other => Err(StreamError::new(format!("unknown stream {other}"))),
    }
}
