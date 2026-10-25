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
mod lex;
mod parser;
mod test_command;
mod tree;
mod word;

#[cfg(test)]
mod tests;

pub use tree::{FIELDS, KINDS, Node, Tree, field_id};

/// Parse a program.
pub fn parse(source: &[u8]) -> Tree {
    parser::parse(source)
}
