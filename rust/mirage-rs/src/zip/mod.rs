//! zip and unzip as Info-ZIP Zip 3.0 and UnZip 6.00 run them, as mirage
//! models them (wording and exit codes from Info-ZIP, Info-ZIP license;
//! see licenses/third_party/info-zip.txt). Each run is one async task over
//! its host: an archive is spooled by the host and read a window at a
//! time (its end record from the tail, then its central directory, then
//! each member's bytes), and every file it writes goes through the host,
//! so no run holds more than a window of the archive.

mod create;
mod format;
mod listing;
#[cfg(test)]
mod tests;
mod unzip;

pub(super) use create::{Piece, ending, fields, keep, placed, write_out};
pub(super) use format::{ARCHIVE, Decoder, Directory, Entry, Spool};

use crate::{Stream, StreamError, parse_config, task};

pub(crate) fn open_zip(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: create::Config = parse_config(config)?;
    Ok(task::spawn(|host| create::run(host, config)))
}

pub(crate) fn open_unzip(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: unzip::Config = parse_config(config)?;
    Ok(task::spawn(|host| unzip::run(host, config)))
}
