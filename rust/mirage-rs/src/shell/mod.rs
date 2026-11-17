//! bash's grammar as a hand-written parser: one pass over a line's bytes
//! builds the tree tree-sitter-bash 0.25.1 builds for it, with its node
//! kinds, field names and byte and point spans, so a host walks either
//! one alike. Where that grammar misreads bash, the tree is bash's
//! reading, spelled with the grammar's kinds. Written from POSIX's shell
//! grammar, the bash manual and the grammar's published node types; no
//! generated lexer, so no one function holds the whole of it.

mod arith;
mod command;
mod compound;
mod cond;
mod expansion;
mod heredoc;
mod heredoc_body;
mod lex;
mod lower;
mod parser;
mod reread;
mod scan;
mod test_command;
mod tree;
mod word;

#[cfg(test)]
mod tests;

pub use parser::Options;
pub use reread::reread_lines;
pub use tree::{FIELDS, Heredoc, KINDS, Node, Refusal, SourceMap, Tree, field_id};

/// Parse a program, extglob's groups on.
pub fn parse(source: &[u8]) -> Tree {
    parser::parse(source, &Options::default())
}

/// Parse a program read as `options` say.
pub fn parse_with(source: &[u8], options: &Options) -> Tree {
    parser::parse(source, options)
}
