mod format;
mod parse;
mod unicode;

pub(crate) use format::open as open_format;
pub(crate) use parse::open as open_scan;
pub(crate) use unicode::open_decode;

#[derive(Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct BeginConfig {
    pub(super) discard: bool,
}
