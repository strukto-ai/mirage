use std::cell::RefCell;
use std::collections::HashMap;

use mirage_rs::{Stream, StreamError};

/// The input window's size: the host copies a chunk of at most this many
/// bytes into it and calls `mirage_rs_feed`, so a chunk costs no allocation
/// however large the input. Calls are synchronous, so every stream shares
/// one window. It holds one block of grep's binary-file probe.
const INPUT_CAPACITY: usize = 96 * 1024;

struct Slot {
    stream: Box<dyn Stream>,
    out: Vec<u8>,
    error: Vec<u8>,
    /// A reply being handed over a window at a time.
    staged: Vec<u8>,
}

#[derive(Default)]
struct State {
    slots: HashMap<u32, Slot>,
    next: u32,
    input: Vec<u8>,
    args: Vec<u8>,
    open_error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with_slot<T>(handle: u32, empty: T, f: impl FnOnce(&mut Slot) -> T) -> T {
    STATE.with_borrow_mut(|state| state.slots.get_mut(&handle).map_or(empty, f))
}

/// Run one stream call, given the first `len` bytes of the input window:
/// 0 is success, 1 a refusal (or no such stream); either way the output so
/// far is at `mirage_rs_output`.
fn call(
    handle: u32,
    len: usize,
    f: impl FnOnce(&mut dyn Stream, &[u8], &mut Vec<u8>) -> Result<(), StreamError>,
) -> i32 {
    STATE.with_borrow_mut(|state| {
        let Some(slot) = state.slots.get_mut(&handle) else {
            return 1;
        };
        slot.out.clear();
        let input = &state.input[..len.min(state.input.len())];
        match f(slot.stream.as_mut(), input, &mut slot.out) {
            Ok(()) => 0,
            Err(err) => {
                slot.error = err.message.into_bytes();
                1
            }
        }
    })
}

/// A scratch buffer of `len` bytes for `mirage_rs_open`'s kind and config.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_args(len: usize) -> *mut u8 {
    STATE.with_borrow_mut(|state| {
        state.args.clear();
        state.args.resize(len, 0);
        state.args.as_mut_ptr()
    })
}

/// Open a stream from the args buffer: `kind_len` bytes of kind, then
/// `config_len` bytes of JSON config. Returns 0 on a refusal, whose message
/// `mirage_rs_error(0)` reads.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_open(kind_len: usize, config_len: usize) -> u32 {
    STATE.with_borrow_mut(|state| {
        let args = std::mem::take(&mut state.args);
        let opened = match args.split_at_checked(kind_len) {
            Some((kind, rest)) if rest.len() == config_len => {
                mirage_rs::open(&String::from_utf8_lossy(kind), rest)
            }
            _ => Err(StreamError::new("bad stream arguments")),
        };
        match opened {
            Ok(stream) => {
                state.next = state.next.wrapping_add(1).max(1);
                let handle = state.next;
                let slot = Slot {
                    stream,
                    out: Vec::new(),
                    error: Vec::new(),
                    staged: Vec::new(),
                };
                state.slots.insert(handle, slot);
                if state.input.is_empty() {
                    state.input = vec![0; INPUT_CAPACITY];
                }
                handle
            }
            Err(err) => {
                state.open_error = err.message.into_bytes();
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_input_capacity() -> usize {
    INPUT_CAPACITY
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_input(handle: u32) -> *mut u8 {
    STATE.with_borrow_mut(|state| {
        if state.slots.contains_key(&handle) {
            state.input.as_mut_ptr()
        } else {
            std::ptr::null_mut()
        }
    })
}

/// Feed the first `len` bytes of the input window.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_feed(handle: u32, len: usize) -> i32 {
    call(handle, len, |stream, input, out| stream.feed(input, out))
}

/// The input a multi-input stream needs next, or -1 when it needs none.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_wants(handle: u32) -> i32 {
    with_slot(handle, -1, |slot| {
        slot.stream
            .wants()
            .map_or(-1, |index| i32::try_from(index).unwrap_or(-1))
    })
}

/// Feed the first `len` bytes of the input window to input `index`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_feed_input(handle: u32, index: usize, len: usize) -> i32 {
    call(handle, len, |stream, input, out| {
        stream.feed_input(index, input, out)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_end_input(handle: u32, index: usize) -> i32 {
    call(handle, 0, |stream, _, out| stream.end_input(index, out))
}

/// 1 while `mirage_rs_drain` has work or output left, else 0.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_busy(handle: u32) -> i32 {
    with_slot(handle, 0, |slot| i32::from(slot.stream.busy()))
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_cancel(handle: u32) -> i32 {
    with_slot(handle, 0, |slot| i32::from(slot.stream.cancel()))
}

/// Bounded steps of the work `mirage_rs_busy` reports, up to a piece of
/// output (`mirage_rs::drain_steps`), and that output.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_drain(handle: u32) -> i32 {
    call(handle, 0, |stream, _, out| {
        mirage_rs::drain_steps(stream, out)
    })
}

/// Start the next input of a stream that reads one after another, its
/// configuration the first `len` bytes of the input window.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_begin(handle: u32, len: usize) -> i32 {
    call(handle, len, |stream, input, _| stream.begin(input))
}

/// Whether the input fed since the last answer, then the first `len` bytes
/// of the input window, passes the stream's test: 1 yes, 0 no, -1 a refusal
/// (or no such stream).
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_test(handle: u32, len: usize) -> i32 {
    STATE.with_borrow_mut(|state| {
        let Some(slot) = state.slots.get_mut(&handle) else {
            return -1;
        };
        slot.out.clear();
        match slot.stream.test(&state.input[..len.min(state.input.len())]) {
            Ok(answer) => i32::from(answer),
            Err(err) => {
                slot.error = err.message.into_bytes();
                -1
            }
        }
    })
}

/// 1 once the stream wants no more of the current input, else 0.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_done(handle: u32) -> i32 {
    with_slot(handle, 1, |slot| i32::from(slot.stream.done()))
}

/// The command's exit status for the input so far.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_status(handle: u32) -> i32 {
    with_slot(handle, 2, |slot| slot.stream.status())
}

/// Put the stream's current progress at `mirage_rs_output`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_metadata(handle: u32) -> i32 {
    call(handle, 0, |stream, _, out| {
        stream.metadata(out);
        Ok(())
    })
}

/// Put what the stream wrote to stderr since the last call at
/// `mirage_rs_output`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_take_stderr(handle: u32) -> i32 {
    call(handle, 0, |stream, _, out| {
        stream.take_stderr(out);
        Ok(())
    })
}

/// Put the request the stream waits on at `mirage_rs_output`, its JSON
/// header then the bytes it carries; returns the header's length, or -1
/// when it waits on none.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_request(handle: u32) -> i32 {
    with_slot(handle, -1, |slot| {
        slot.out.clear();
        let mut data = Vec::new();
        match slot.stream.request(&mut data) {
            Some(header) => {
                slot.out.extend_from_slice(&header);
                slot.out.append(&mut data);
                i32::try_from(header.len()).unwrap_or(-1)
            }
            None => -1,
        }
    })
}

/// Append the first `len` bytes of the input window to the reply being
/// handed over.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_stage(handle: u32, len: usize) -> i32 {
    STATE.with_borrow_mut(|state| {
        let Some(slot) = state.slots.get_mut(&handle) else {
            return 1;
        };
        slot.staged
            .extend_from_slice(&state.input[..len.min(state.input.len())]);
        0
    })
}

/// Answer the request taken last with the staged reply: `reply_len` bytes
/// of JSON, then the bytes it carries.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_respond(handle: u32, reply_len: usize) -> i32 {
    with_slot(handle, 1, |slot| {
        slot.out.clear();
        let staged = std::mem::take(&mut slot.staged);
        let (reply, data) = staged.split_at(reply_len.min(staged.len()));
        match slot.stream.respond(reply, data, &mut slot.out) {
            Ok(()) => 0,
            Err(err) => {
                slot.error = err.message.into_bytes();
                1
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_finish(handle: u32) -> i32 {
    call(handle, 0, |stream, _, out| stream.finish(out))
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_output(handle: u32) -> *const u8 {
    with_slot(handle, std::ptr::null(), |slot| slot.out.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_output_len(handle: u32) -> usize {
    with_slot(handle, 0, |slot| slot.out.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_error(handle: u32) -> *const u8 {
    if handle == 0 {
        return STATE.with_borrow(|state| state.open_error.as_ptr());
    }
    with_slot(handle, std::ptr::null(), |slot| slot.error.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_error_len(handle: u32) -> usize {
    if handle == 0 {
        return STATE.with_borrow(|state| state.open_error.len());
    }
    with_slot(handle, 0, |slot| slot.error.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_close(handle: u32) {
    STATE.with_borrow_mut(|state| {
        state.slots.remove(&handle);
    });
}

/// How many streams are open, so the host can drop the instance (and the
/// linear memory a large stream grew, which wasm never returns) once none is.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_open_count() -> usize {
    STATE.with_borrow(|state| state.slots.len())
}

struct Server {
    server: mirage_rs::nfs::Server,
    buffer: Vec<u8>,
    out: Vec<u8>,
    error: Vec<u8>,
}

thread_local! {
    static SERVERS: RefCell<HashMap<u32, Server>> = RefCell::new(HashMap::new());
}

fn with_server<T>(handle: u32, empty: T, f: impl FnOnce(&mut Server) -> T) -> T {
    SERVERS.with_borrow_mut(|servers| servers.get_mut(&handle).map_or(empty, f))
}

/// Open an NFS server from the args buffer's `config_len` bytes of JSON
/// config. Returns 0 on a refusal, whose message `mirage_rs_error(0)` reads.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_open(config_len: usize) -> u32 {
    let args = STATE.with_borrow_mut(|state| std::mem::take(&mut state.args));
    let config = &args[..config_len.min(args.len())];
    match mirage_rs::nfs::Server::new(config) {
        Ok(server) => SERVERS.with_borrow_mut(|servers| {
            let handle = STATE.with_borrow_mut(|state| {
                state.next = state.next.wrapping_add(1).max(1);
                state.next
            });
            let server = Server {
                server,
                buffer: Vec::new(),
                out: Vec::new(),
                error: Vec::new(),
            };
            servers.insert(handle, server);
            handle
        }),
        Err(err) => {
            STATE.with_borrow_mut(|state| state.open_error = err.message.into_bytes());
            0
        }
    }
}

/// A buffer of `len` bytes for the next `mirage_rs_nfs_feed` or
/// `mirage_rs_nfs_complete`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_buffer(handle: u32, len: usize) -> *mut u8 {
    with_server(handle, std::ptr::null_mut(), |server| {
        server.buffer.clear();
        server.buffer.resize(len, 0);
        server.buffer.as_mut_ptr()
    })
}

/// Take the buffer's first `len` bytes as what connection `conn` sent; the
/// replies they answer at once are at `mirage_rs_nfs_output`. 0 is
/// success, 1 a refusal.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_feed(handle: u32, conn: u32, len: usize) -> i32 {
    with_server(handle, 1, |server| {
        server.out.clear();
        let data = &server.buffer[..len.min(server.buffer.len())];
        match server.server.feed(conn, data, &mut server.out) {
            Ok(()) => 0,
            Err(err) => {
                server.error = err.message.into_bytes();
                1
            }
        }
    })
}

/// Put the requests calls wait on, a JSON array, at `mirage_rs_nfs_output`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_requests(handle: u32) -> i32 {
    with_server(handle, 1, |server| {
        server.out.clear();
        server.server.requests(&mut server.out);
        0
    })
}

/// Complete request `id` with the buffer: `reply_len` bytes of JSON reply,
/// then `data_len` bytes of data. The call's reply, once it has one, is at
/// `mirage_rs_nfs_output`. Returns the call's connection, -1 when it has
/// closed, -2 on a refusal.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_complete(
    handle: u32,
    id: u32,
    reply_len: usize,
    data_len: usize,
) -> i32 {
    with_server(handle, -2, |server| {
        server.out.clear();
        let Some((reply, rest)) = server.buffer.split_at_checked(reply_len) else {
            return -2;
        };
        let data = &rest[..data_len.min(rest.len())];
        match server.server.complete(id, reply, data, &mut server.out) {
            Ok(Some(conn)) => i32::try_from(conn).unwrap_or(-2),
            Ok(None) => -1,
            Err(err) => {
                server.error = err.message.into_bytes();
                -2
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_output(handle: u32) -> *const u8 {
    with_server(handle, std::ptr::null(), |server| server.out.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_output_len(handle: u32) -> usize {
    with_server(handle, 0, |server| server.out.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_error(handle: u32) -> *const u8 {
    with_server(handle, std::ptr::null(), |server| server.error.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_error_len(handle: u32) -> usize {
    with_server(handle, 0, |server| server.error.len())
}

/// Forget connection `conn` and the calls it has out.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_disconnect(handle: u32, conn: u32) {
    with_server(handle, (), |server| server.server.close(conn));
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_nfs_close(handle: u32) {
    SERVERS.with_borrow_mut(|servers| {
        servers.remove(&handle);
    });
}

/// The last shell parse: its node table, its error, and what the tree
/// says of the line beyond its nodes.
#[derive(Default)]
struct Parsed {
    table: Vec<u32>,
    error_at: i32,
    status: u8,
    message: Vec<u8>,
    names: Vec<u8>,
    extras: Vec<u32>,
    text: Vec<u8>,
}

thread_local! {
    static PARSED: RefCell<Parsed> = RefCell::new(Parsed::default());
}

/// How many `u32`s one node takes in the table.
const NODE_WORDS: usize = 10;

/// The UTF-16 offset of each byte offset of `source`, which is how a
/// host's strings count: a character takes one unit, or two past the
/// BMP, and a byte that starts no UTF-8 character one, as the host's text
/// carries it. A character's later bytes stand at its end.
fn utf16_offsets(source: &[u8]) -> Vec<u32> {
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
    offsets
}

/// Parse the args buffer's first `len` bytes as a shell program, the
/// `aliases_len` after them naming the shell's aliases, each ended by a NUL,
/// extglob's pattern groups on when `extglob` is not 0.
/// Its node table, `NODE_WORDS` words a node level by level, offsets and columns in
/// UTF-16 units of the text the tree reads, is at `mirage_rs_shell_table` until
/// the next parse: kind | field << 16 | flags << 24 (1 named),
/// start, end, start row, start column, end row, end column, parent,
/// first child, child count. Returns the node count. The rest of the parse
/// is at `mirage_rs_shell_extras` and `mirage_rs_shell_text`.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_shell_parse(len: usize, aliases_len: usize, extglob: u32) -> usize {
    let args = STATE.with_borrow_mut(|state| std::mem::take(&mut state.args));
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
    let typed = utf16_offsets(source);
    let column =
        |offset: u32, bytes: u32| utf16[offset as usize] - utf16[(offset - bytes) as usize];
    PARSED.with_borrow_mut(|parsed| {
        parsed.table.clear();
        parsed.table.reserve(tree.nodes.len() * NODE_WORDS);
        for node in &tree.nodes {
            let flags = u32::from(node.named);
            parsed.table.extend_from_slice(&[
                u32::from(node.kind) | u32::from(node.field) << 16 | flags << 24,
                utf16[node.start as usize],
                utf16[node.end as usize],
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
                parsed.error_at =
                    i32::try_from(typed[refusal.at.min(source.len())]).unwrap_or(i32::MAX);
                parsed.status = refusal.status;
                parsed.message.clone_from(&refusal.message);
            }
            None => {
                parsed.error_at = -1;
                parsed.message.clear();
            }
        }
        extras(&tree, &utf16, &typed, parsed);
    });
    tree.nodes.len()
}

/// Fill `extras` and `text`: a header of the source's byte length, the
/// heredoc count, the count of nodes with an inlined text and the
/// warnings' byte length; then where each UTF-16 unit of the source came
/// from in the line as typed, and its end; then per heredoc its `<` in
/// the source, its `<<`, word end, body start and end in the line as
/// typed, flags (1 quoted, 2 terminated, 4 `<<-`) and the byte lengths of
/// its word, delimiter and body; then per such node its index and the byte
/// length of its text. `text` holds the source, each heredoc's word,
/// delimiter and body, each inlined text and the warnings, in that order.
fn extras(tree: &mirage_rs::shell::Tree, utf16: &[u32], typed: &[u32], parsed: &mut Parsed) {
    let inlined: Vec<(usize, Vec<u8>)> = if tree.closes.is_empty() {
        Vec::new()
    } else {
        (0..tree.nodes.len())
            .map(|index| (index, tree.inlined(index)))
            .filter(|(_, text)| !text.is_empty())
            .collect()
    };
    let warnings = tree.warnings();
    let extras = &mut parsed.extras;
    let text = &mut parsed.text;
    extras.clear();
    text.clear();
    let count = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
    extras.extend_from_slice(&[
        count(tree.source.len()),
        count(tree.heredocs.len()),
        count(inlined.len()),
        count(warnings.len()),
    ]);
    // Each unit a byte starts maps to where that byte came from.
    for at in 0..tree.source.len() {
        let origin = typed[tree.offsets[at]];
        extras.extend((0..utf16[at + 1] - utf16[at]).map(|unit| origin + unit));
    }
    extras.push(typed[tree.offsets[tree.source.len()]]);
    text.extend_from_slice(&tree.source);
    for heredoc in &tree.heredocs {
        extras.extend_from_slice(&[
            utf16[heredoc.at],
            typed[heredoc.operator],
            typed[heredoc.word_end],
            typed[heredoc.body_start],
            typed[heredoc.end],
            u32::from(heredoc.quoted)
                | u32::from(heredoc.terminated) << 1
                | u32::from(heredoc.dash) << 2,
            count(heredoc.word.len()),
            count(heredoc.delimiter.len()),
            count(heredoc.body.len()),
        ]);
        text.extend_from_slice(&heredoc.word);
        text.extend_from_slice(&heredoc.delimiter);
        text.extend_from_slice(&heredoc.body);
    }
    for (index, inlined) in &inlined {
        extras.extend_from_slice(&[count(*index), count(inlined.len())]);
        text.extend_from_slice(inlined);
    }
    text.extend_from_slice(&warnings);
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
