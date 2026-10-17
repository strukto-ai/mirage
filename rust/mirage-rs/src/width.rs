use crate::generated::unicode_width::{SPACE, WIDE, ZERO};

pub(crate) const TAB_WIDTH: u64 = 8;

fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// The columns a character takes, as GNU `wc -L` 9.7 counts them in
/// C.UTF-8: one that does not print takes none, and so does a form past
/// U+10FFFF, which decodes but cannot print.
pub(crate) fn char_width(cp: u32) -> u64 {
    if cp > 0x10_FFFF || in_ranges(cp, ZERO) {
        0
    } else if in_ranges(cp, WIDE) {
        2
    } else {
        1
    }
}

/// A character that separates words, as GNU `wc` 9.7 splits them in C.UTF-8.
pub(crate) fn is_space(cp: u32) -> bool {
    in_ranges(cp, SPACE)
}

/// The column after `cp`: a tab jumps to the next stop, carriage return and
/// form feed rewind to 0. The newline is the caller's.
pub(crate) fn advance_column(column: u64, cp: u32) -> u64 {
    match cp {
        0x0D | 0x0C => 0,
        0x09 => column + TAB_WIDTH - column % TAB_WIDTH,
        _ => column + char_width(cp),
    }
}
