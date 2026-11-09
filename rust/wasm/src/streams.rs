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
    /// The status the last refusal exits with.
    status: i32,
    /// A reply being handed over a window at a time.
    staged: Vec<u8>,
}

#[derive(Default)]
pub(crate) struct State {
    slots: HashMap<u32, Slot>,
    pub(crate) next: u32,
    input: Vec<u8>,
    pub(crate) args: Vec<u8>,
    open_error: Vec<u8>,
    open_status: i32,
}

impl Slot {
    fn refuse(&mut self, err: StreamError) {
        self.error = err.message.into_bytes();
        self.status = err.status;
    }
}

impl State {
    pub(crate) fn refuse_open(&mut self, err: StreamError) {
        self.open_error = err.message.into_bytes();
        self.open_status = err.status;
    }
}

thread_local! {
    pub(crate) static STATE: RefCell<State> = RefCell::new(State::default());
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
        mirage_rs::release_capacity(&mut slot.out);
        let input = &state.input[..len.min(state.input.len())];
        match f(slot.stream.as_mut(), input, &mut slot.out) {
            Ok(()) => 0,
            Err(err) => {
                slot.refuse(err);
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
                crate::open_stream(&String::from_utf8_lossy(kind), rest)
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
                    status: 0,
                    staged: Vec::new(),
                };
                state.slots.insert(handle, slot);
                if state.input.is_empty() {
                    state.input = vec![0; INPUT_CAPACITY];
                }
                handle
            }
            Err(err) => {
                state.refuse_open(err);
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
        mirage_rs::release_capacity(&mut slot.out);
        match slot.stream.test(&state.input[..len.min(state.input.len())]) {
            Ok(answer) => i32::from(answer),
            Err(err) => {
                slot.refuse(err);
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
        mirage_rs::release_capacity(&mut slot.out);
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
        mirage_rs::release_capacity(&mut slot.out);
        let staged = std::mem::take(&mut slot.staged);
        let (reply, data) = staged.split_at(reply_len.min(staged.len()));
        match slot.stream.respond(reply, data, &mut slot.out) {
            Ok(()) => 0,
            Err(err) => {
                slot.refuse(err);
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

/// The status the refusal `mirage_rs_error` reads exits with.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_error_status(handle: u32) -> i32 {
    if handle == 0 {
        return STATE.with_borrow(|state| state.open_status);
    }
    with_slot(handle, 1, |slot| slot.status)
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
