use serde::{Deserialize, Serialize};

use crate::number::is_blank;

/// One key's ordering options.
#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Mods {
    pub numeric: bool,
    pub general_numeric: bool,
    pub human: bool,
    pub version: bool,
    pub month: bool,
    pub fold: bool,
    pub reverse: bool,
    pub dictionary: bool,
    pub ignore_nonprinting: bool,
    /// `-R`: the key's salted hash orders it, so equal keys stay together.
    pub random: bool,
}

/// The bytes `-d` keeps (alphanumerics and blanks) and `-i` keeps
/// (printable ASCII) in the C locale.
pub(super) fn kept(byte: u8, mods: &Mods) -> bool {
    if mods.dictionary {
        byte.is_ascii_alphanumeric() || is_blank(byte)
    } else if mods.ignore_nonprinting {
        (0x20..0x7F).contains(&byte)
    } else {
        true
    }
}
