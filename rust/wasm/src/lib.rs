use std::cell::RefCell;
use std::collections::HashMap;

use mirage_rs::{Stream, StreamError};

mod streams;

use streams::STATE;

fn open_stream(kind: &str, config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    mirage_rs::open(kind, config)
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
            STATE.with_borrow_mut(|state| state.refuse_open(err));
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
