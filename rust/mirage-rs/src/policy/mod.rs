mod pattern;
mod profile;
mod types;
mod visibility;

pub use pattern::{pattern_matches, pattern_reaches, split_pattern};
pub use types::*;

pub use profile::{compile_profile, restrict_profile};
pub use visibility::{
    VisibilityMatcher, anchor_depth, classify_paths, classify_vars, is_glob, show_head,
};
