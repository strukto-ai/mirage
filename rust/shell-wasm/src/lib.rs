#[cfg(target_arch = "wasm32")]
#[cfg(target_arch = "wasm32")]
mod session;

use mirage_rs::shell::SourceMap;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

thread_local! {
    /// The request the host writes before a call: a line to parse, or an
    /// engine request.
    static ARGS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// A scratch buffer of `len` bytes for the next call's request.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_args(len: usize) -> *mut u8 {
    ARGS.with_borrow_mut(|args| {
        args.clear();
        args.resize(len, 0);
        args.as_mut_ptr()
    })
}

/// The last shell parse: its node table, its error, what the tree says of
/// the line beyond its nodes, and the handle the tree is kept under.
#[derive(Default)]
struct Parsed {
    table: Vec<u32>,
    tree: u32,
    error_at: i32,
    status: u8,
    message: Vec<u8>,
    message_tree: u32,
    names: Vec<u8>,
    extras: Vec<u32>,
    text: Vec<u8>,
    reread: Vec<u32>,
    reread_tree: u32,
}

/// The trees parses kept, each until the host drops it, for the engine's
/// tasks to expand nodes of.
#[derive(Default)]
struct Trees {
    kept: HashMap<u32, Arc<mirage_rs::shell::Tree>>,
    next: u32,
}

thread_local! {
    static PARSED: RefCell<Parsed> = RefCell::new(Parsed::default());
    static TREES: RefCell<Trees> = RefCell::new(Trees::default());
}

/// A tree a parse kept, None once the host dropped it.
#[cfg(target_arch = "wasm32")]
fn shell_tree(handle: u32) -> Option<Arc<mirage_rs::shell::Tree>> {
    TREES.with_borrow(|trees| trees.kept.get(&handle).cloned())
}

/// How many `u32`s one node takes in the table.
const NODE_WORDS: usize = 10;

/// The UTF-16 offset of each byte offset of `source`, which is how a
/// host's strings count: a character takes one unit, or two past the
/// BMP, and a byte that starts no UTF-8 character one, as the host's text
/// carries it. A character's later bytes stand at its end.
fn utf16_offsets(source: &[u8]) -> SourceMap {
    if source.is_ascii() {
        return SourceMap::Identity(source.len() + 1);
    }
    let mut offsets = Vec::with_capacity(source.len() + 1);
    let mut units = 0u32;
    let mut at = 0;
    while at < source.len() {
        let len = match source[at] {
            0x00..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => 0,
        };
        let valid = len > 0
            && source
                .get(at..at + len)
                .is_some_and(|chunk| std::str::from_utf8(chunk).is_ok());
        offsets.push(units);
        if !valid {
            units += 1;
            at += 1;
            continue;
        }
        units += if len == 4 { 2 } else { 1 };
        offsets.extend(std::iter::repeat_n(units, len - 1));
        at += len;
    }
    offsets.push(units);
    SourceMap::Packed(offsets)
}

/// Parse the args buffer's first `len` bytes as a shell program, the
/// `aliases_len` after them naming the shell's aliases, each ended by a NUL,
/// extglob's pattern groups on when `extglob` is not 0.
/// Its node table, `NODE_WORDS` words a node level by level, offsets and columns in
/// UTF-16 units of the text the tree reads, is at `mirage_rs_shell_table` until
/// the next parse or dropping that tree: kind | field << 16 | flags << 24 (1 named),
/// start, end, start row, start column, end row, end column, parent,
/// first child, child count. Returns the node count. The rest of the parse
/// is at `mirage_rs_shell_extras` and `mirage_rs_shell_text`, and the tree
/// stays kept under `mirage_rs_shell_tree`'s handle for the engine.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_parse(len: usize, aliases_len: usize, extglob: u32) -> usize {
    let args = ARGS.with_borrow_mut(std::mem::take);
    let source = &args[..len.min(args.len())];
    let options = mirage_rs::shell::Options {
        aliases: args[source.len()..(len + aliases_len).min(args.len())]
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .map(<[u8]>::to_vec)
            .collect(),
        extglob: extglob != 0,
    };
    let tree = mirage_rs::shell::parse_with(source, &options);
    let utf16 = utf16_offsets(&tree.source);
    let typed;
    let typed = if tree.offsets.is_identity() {
        &utf16
    } else {
        typed = utf16_offsets(source);
        &typed
    };
    let column = |offset: u32, bytes: u32| {
        utf16.at(offset as usize) as u32 - utf16.at((offset - bytes) as usize) as u32
    };
    PARSED.with_borrow_mut(|parsed| {
        parsed.table.clear();
        parsed.table.reserve(tree.nodes.len() * NODE_WORDS);
        for node in &tree.nodes {
            let flags = u32::from(node.named);
            parsed.table.extend_from_slice(&[
                u32::from(node.kind) | u32::from(node.field) << 16 | flags << 24,
                utf16.at(node.start as usize) as u32,
                utf16.at(node.end as usize) as u32,
                node.start_row,
                column(node.start, node.start_column),
                node.end_row,
                column(node.end, node.end_column),
                node.parent,
                node.first_child,
                node.child_count,
            ]);
        }
        match &tree.error {
            Some(refusal) => {
                parsed.error_at = i32::try_from(typed.at(refusal.at.min(source.len())) as u32)
                    .unwrap_or(i32::MAX);
                parsed.status = refusal.status;
            }
            None => parsed.error_at = -1,
        }
        extras(&tree, &utf16, typed, parsed);
    });
    let count = tree.nodes.len();
    let handle = TREES.with_borrow_mut(|trees| {
        trees.next = trees.next.wrapping_add(1).max(1);
        while trees.kept.contains_key(&trees.next) {
            trees.next = trees.next.wrapping_add(1).max(1);
        }
        trees.kept.insert(trees.next, Arc::new(tree));
        trees.next
    });
    PARSED.with_borrow_mut(|parsed| parsed.tree = handle);
    count
}

/// The handle the last parse's tree is kept under, until
/// `mirage_rs_shell_drop_tree`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_tree() -> u32 {
    PARSED.with_borrow(|parsed| parsed.tree)
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_drop_tree(handle: u32) {
    TREES.with_borrow_mut(|trees| {
        trees.kept.remove(&handle);
    });
    PARSED.with_borrow_mut(|parsed| {
        if parsed.tree == handle {
            parsed.tree = 0;
            clear_scratch(&mut parsed.table);
            clear_scratch(&mut parsed.extras);
            clear_scratch(&mut parsed.text);
        }
        if parsed.message_tree == handle {
            parsed.message_tree = 0;
            clear_scratch(&mut parsed.message);
        }
        if parsed.reread_tree == handle {
            parsed.reread_tree = 0;
            clear_scratch(&mut parsed.reread);
        }
    });
}

fn clear_scratch<T>(buffer: &mut Vec<T>) {
    buffer.clear();
    if buffer.capacity() * std::mem::size_of::<T>() > 65536 {
        *buffer = Vec::new();
    }
}

/// Fill `extras` and `text`: a header of the source's byte length, the
/// heredoc count, the count of nodes with an inlined text, and the map length
/// (zero for identity); then where
/// each UTF-16 unit of the source came from in the line as typed, and its
/// end; then per heredoc its `<` in the source, its `<<`, word end, body
/// start and end in the line as typed, flags (1 quoted, 2 terminated, 4
/// `<<-`), the byte lengths of its word, delimiter and body, and where in
/// its body expanding it fails and the row the body starts on (`u32::MAX`
/// when it does not); then per
/// such node its index and the byte length of its text. `text` holds the
/// source, each heredoc's word, delimiter and body and each inlined text,
/// in that order.
fn extras(
    tree: &mirage_rs::shell::Tree,
    utf16: &SourceMap,
    typed: &SourceMap,
    parsed: &mut Parsed,
) {
    let inlined: Vec<(usize, Vec<u8>)> = if tree.closes.is_empty() {
        Vec::new()
    } else {
        (0..tree.nodes.len())
            .map(|index| (index, tree.inlined(index)))
            .filter(|(_, text)| !text.is_empty())
            .collect()
    };
    let extras = &mut parsed.extras;
    let text = &mut parsed.text;
    extras.clear();
    text.clear();
    let count = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
    extras.extend_from_slice(&[
        count(tree.source.len()),
        count(tree.heredocs.len()),
        count(inlined.len()),
        if tree.offsets.is_identity() {
            0
        } else {
            count(utf16.at(tree.source.len()) + 1)
        },
    ]);
    // Each unit a byte starts maps to where that byte came from.
    if !tree.offsets.is_identity() {
        for at in 0..tree.source.len() {
            let origin = typed.at(tree.offsets.at(at)) as u32;
            extras.extend(
                (0..utf16.at(at + 1) as u32 - utf16.at(at) as u32).map(|unit| origin + unit),
            );
        }
        extras.push(typed.at(tree.offsets.at(tree.source.len())) as u32);
    }
    text.extend_from_slice(&tree.source);
    for heredoc in &tree.heredocs {
        extras.extend_from_slice(&[
            utf16.at(heredoc.at) as u32,
            typed.at(heredoc.operator) as u32,
            typed.at(heredoc.word_end) as u32,
            typed.at(heredoc.body_start) as u32,
            typed.at(heredoc.end) as u32,
            u32::from(heredoc.quoted)
                | u32::from(heredoc.terminated) << 1
                | u32::from(heredoc.dash) << 2,
            count(heredoc.word.len()),
            count(heredoc.delimiter.len()),
            count(heredoc.body.len()),
            heredoc
                .deferred
                .map_or(u32::MAX, |deferred| count(deferred.at)),
            heredoc
                .deferred
                .map_or(u32::MAX, |deferred| count(deferred.row)),
        ]);
        text.extend_from_slice(&heredoc.word);
        text.extend_from_slice(&heredoc.delimiter);
        text.extend_from_slice(&heredoc.body);
    }
    for (index, inlined) in &inlined {
        extras.extend_from_slice(&[count(*index), count(inlined.len())]);
        text.extend_from_slice(inlined);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_extras() -> *const u32 {
    PARSED.with_borrow(|parsed| parsed.extras.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_extras_len() -> usize {
    PARSED.with_borrow(|parsed| parsed.extras.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_text() -> *const u8 {
    PARSED.with_borrow(|parsed| parsed.text.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_text_len() -> usize {
    PARSED.with_borrow(|parsed| parsed.text.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_table() -> *const u32 {
    PARSED.with_borrow(|parsed| parsed.table.as_ptr())
}

/// Where in the line as typed the last parse's refusal is, in UTF-16
/// units; -1 for none.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_error_at() -> i32 {
    PARSED.with_borrow(|parsed| parsed.error_at)
}

/// The status the last parse's line is refused with.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_status() -> u32 {
    PARSED.with_borrow(|parsed| u32::from(parsed.status))
}

/// Word what bash prints of the tree kept under `handle` into the message
/// buffer, each line led by the args buffer's first `head_len` bytes and
/// its line, the input's first row being `first`: its refusal for `what`
/// 0, under a UTF-8 locale when `utf8` is 1, its heredoc warnings for 1.
/// Returns the byte length.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_words(
    handle: u32,
    what: u32,
    head_len: usize,
    first: usize,
    utf8: u32,
) -> usize {
    let args = ARGS.with_borrow_mut(std::mem::take);
    let head = &args[..head_len.min(args.len())];
    let words = TREES
        .with_borrow(|trees| trees.kept.get(&handle).cloned())
        .map(|tree| match what {
            0 => tree
                .error
                .as_ref()
                .map(|refusal| refusal.worded(head, first, utf8 == 1))
                .unwrap_or_default(),
            _ => tree.warnings(head, first),
        })
        .unwrap_or_default();
    PARSED.with_borrow_mut(|parsed| {
        parsed.message_tree = handle;
        parsed.message = words;
        parsed.message.len()
    })
}

/// Lay the tree kept under `handle` out from node `index` as bash prints
/// a `$( )` body it reads again: per node under it, its index, the line
/// `$LINENO` numbers it by and the line it ends on, from 0, into the
/// reread buffer. Returns how many numbers it holds.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_reread(handle: u32, index: u32) -> usize {
    let lines = TREES
        .with_borrow(|trees| trees.kept.get(&handle).cloned())
        .map(|tree| mirage_rs::shell::reread_lines(&tree, index as usize))
        .unwrap_or_default();
    PARSED.with_borrow_mut(|parsed| {
        parsed.reread_tree = handle;
        parsed.reread.clear();
        for (node, line, end) in lines {
            parsed.reread.extend_from_slice(&[node, line, end]);
        }
        parsed.reread.len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_reread_lines() -> *const u32 {
    PARSED.with_borrow(|parsed| parsed.reread.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_message() -> *const u8 {
    PARSED.with_borrow(|parsed| parsed.message.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_message_len() -> usize {
    PARSED.with_borrow(|parsed| parsed.message.len())
}

/// Node kind names, then field names, each NUL-terminated; a kind's name
/// starts with `1` when the kind is named, `0` when not, and an empty name
/// ends the kinds.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_names() -> *const u8 {
    PARSED.with_borrow_mut(|parsed| {
        if parsed.names.is_empty() {
            for (name, named) in mirage_rs::shell::KINDS {
                parsed.names.push(if *named { b'1' } else { b'0' });
                parsed.names.extend_from_slice(name.as_bytes());
                parsed.names.push(0);
            }
            parsed.names.push(0);
            for field in mirage_rs::shell::FIELDS {
                parsed.names.extend_from_slice(field.as_bytes());
                parsed.names.push(0);
            }
        }
        parsed.names.as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_names_len() -> usize {
    PARSED.with_borrow(|parsed| parsed.names.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_oldest_tree_releases_later_diagnostic_scratch() {
        let source = b"echo $(echo hi)";
        ARGS.with_borrow_mut(|args| *args = source.to_vec());
        mirage_rs_shell_parse(source.len(), 0, 1);
        let older = mirage_rs_shell_tree();
        ARGS.with_borrow_mut(|args| *args = b"echo newer".to_vec());
        mirage_rs_shell_parse(10, 0, 1);
        mirage_rs_shell_drop_tree(mirage_rs_shell_tree());
        assert!(mirage_rs_shell_reread(older, 0) > 0);
        mirage_rs_shell_words(older, 1, 0, 1, 1);
        PARSED.with_borrow_mut(|parsed| {
            parsed.reread.reserve(32768);
            parsed.message = vec![b'x'; 131072];
        });
        mirage_rs_shell_drop_tree(older);
        PARSED.with_borrow(|parsed| {
            assert_eq!(parsed.reread.capacity(), 0);
            assert_eq!(parsed.message.capacity(), 0);
        });
    }

    #[test]
    fn utf16_coordinates_include_non_bmp_and_invalid_bytes() {
        let offsets = utf16_offsets(b"a\xc3\xa9\xf0\x9f\x98\x80\xff");
        assert_eq!(
            offsets.iter().collect::<Vec<_>>(),
            [0, 1, 2, 2, 4, 4, 4, 4, 5]
        );
        assert!(utf16_offsets(b"echo x").is_identity());
    }

    #[test]
    fn transformed_extras_map_units_and_drop_releases_scratch() {
        ARGS.with_borrow_mut(|args| *args = "ec\\\nho é😀".as_bytes().to_vec());
        mirage_rs_shell_parse(13, 0, 1);
        let handle = mirage_rs_shell_tree();
        PARSED.with_borrow(|parsed| {
            assert_eq!(parsed.error_at, -1);
            assert_eq!(parsed.extras[3], 9);
            assert_eq!(&parsed.extras[4..13], &[0, 1, 4, 5, 6, 7, 8, 9, 10]);
        });
        let held = TREES.with_borrow(|trees| trees.kept[&handle].clone());
        mirage_rs_shell_drop_tree(handle);
        mirage_rs_shell_drop_tree(handle);
        TREES.with_borrow(|trees| assert!(!trees.kept.contains_key(&handle)));
        assert_eq!(held.source.as_slice(), "echo é😀".as_bytes());
        PARSED.with_borrow(|parsed| assert!(parsed.text.is_empty() && parsed.extras.is_empty()));
        let mut oversized = Vec::<u8>::with_capacity(1048576);
        oversized.push(1);
        clear_scratch(&mut oversized);
        assert_eq!(oversized.capacity(), 0);
        let mut small = Vec::<u8>::with_capacity(32);
        clear_scratch(&mut small);
        assert_eq!(small.capacity(), 32);
    }
}
