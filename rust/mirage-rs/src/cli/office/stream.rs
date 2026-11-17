// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.

use super::document::{self, Kind};
use super::types::Config;
use super::xml::text;
use crate::task::{self, Host};
use crate::{Stream, StreamError, parse_config};

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(task::spawn(|host| run(host, config)))
}

/// A Word document or a deck runs on its package; anything else is a
/// workbook.
async fn run(host: Host, config: Config) -> i32 {
    if let Some(kind) = Kind::of(&text(&config.file)) {
        return document::run(&host, &config, kind).await;
    }
    super::run(host, config).await
}
