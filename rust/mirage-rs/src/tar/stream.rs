use std::sync::Mutex;

use super::{Config, Mode, create, options, read, update};
use crate::{Stream, StreamError, parse_config, task};

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let mut config: Config = parse_config(config)?;
    if let Some(typed) = &config.typed {
        let read = options::read(typed)?;
        config.strip = read.strip;
        config.overwrites = read.overwrites;
        config.owner = read.owner;
        config.group = read.group;
        config.transforms = Mutex::new(read.transforms);
    }
    Ok(task::spawn(|host| async move {
        match config.mode {
            Mode::Create => create::run(&host, &config).await,
            Mode::List | Mode::Extract => read::run(&host, &config).await,
            Mode::Append | Mode::Update | Mode::Delete => update::run(&host, &config).await,
        }
    }))
}
