//! What a command's scan grammar reads its typed options with: the
//! shapes the `scan` stream hands each grammar and the helpers they
//! share.

use serde_json::{Map, Value as Json};

use crate::StreamError;

/// The tape name of an operand. No option's dest is empty.
pub(crate) const OPERAND: &str = "";

/// One option as typed: its name and its value's bytes.
pub(crate) type Typed = (String, Vec<u8>);

/// What a command's grammar makes of its options: every value by name.
pub(crate) type Values = Map<String, Json>;

/// An option the command's grammar does not read: the host's mistake, not
/// the line's.
pub(crate) fn unknown(command: &str, name: &str) -> StreamError {
    StreamError::new(format!("scan: {command} reads no option {name}"))
}

/// The last occurrence of option `name`, the one a program that keeps a
/// value and checks it once its options are read refuses.
pub(crate) fn last<'a>(options: &'a [Typed], name: &str) -> Option<&'a [u8]> {
    options
        .iter()
        .rev()
        .find(|(typed, _)| typed == name)
        .map(|(_, raw)| raw.as_slice())
}

/// Each option's last occurrence, in the order those occurrences were
/// typed: what a host's parsed flags keep of a scalar option typed twice.
pub(crate) fn latest(options: &[Typed]) -> Vec<&Typed> {
    options
        .iter()
        .enumerate()
        .filter(|(at, (name, _))| !options[at + 1..].iter().any(|(later, _)| later == name))
        .map(|(_, typed)| typed)
        .collect()
}
