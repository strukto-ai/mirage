mod builtin;
mod compile;
mod eval;
mod format;
mod host;
mod onig;
mod parse;
mod regex;
mod syntax;
#[cfg(test)]
mod tests;
mod time;
mod unicode;
mod value;
mod vm;

pub(crate) use eval::open as open_eval;
pub(crate) use format::open as open_format;
pub(crate) use parse::open as open_scan;
pub(crate) use unicode::open_decode;

#[derive(Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct BeginConfig {
    pub(super) discard: bool,
}
