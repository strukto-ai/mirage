use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountAlloc;
static LARGE: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static SERIAL: Mutex<()> = Mutex::new(());
const NAME_BYTES: usize = 90000;
const NUMBER_BYTES: usize = 60000;

unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.size() >= NUMBER_BYTES {
            LARGE.fetch_add(1, Ordering::Relaxed);
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if layout.size() >= NUMBER_BYTES {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if layout.size() >= NUMBER_BYTES {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        if new_size >= NUMBER_BYTES {
            LARGE.fetch_add(1, Ordering::Relaxed);
            let live = LIVE.fetch_add(new_size, Ordering::Relaxed) + new_size;
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountAlloc = CountAlloc;

#[test]
fn localtime_shares_a_posix_name_after_completion_or_cancel() {
    let _serial = SERIAL.lock().unwrap();
    let config = serde_json::to_vec(&serde_json::json!({
        "program": "localtime | .[3]",
        "steps": 1,
        "memory": 100000,
        "zone": format!("<{}>0", "x".repeat(NAME_BYTES)),
    }))
    .unwrap();
    let mut stream = mirage_rs::open("jq_eval", &config).unwrap();
    for cancel in [false, true, false] {
        let mut wire = Vec::new();
        stream.begin(b"{}").unwrap();
        stream.feed(b"0", &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        LARGE.store(0, Ordering::Relaxed);
        if cancel {
            assert!(stream.cancel());
        }
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
        assert_eq!(LARGE.load(Ordering::Relaxed), 0);
        assert_eq!(
            wire,
            if cancel {
                vec![]
            } else {
                vec![1, 1, 0, 0, 0, b'0']
            }
        );
    }
}

#[test]
fn negation_keeps_only_its_input_and_result_literal_buffers() {
    let _serial = SERIAL.lock().unwrap();
    let config = serde_json::to_vec(&serde_json::json!({
        "program": ". as $x | input | -$x | empty",
        "steps": 7,
        "memory": 140000,
    }))
    .unwrap();
    let mut stream = mirage_rs::open("jq_eval", &config).unwrap();
    let mut wire = Vec::new();
    stream
        .feed("1".repeat(NUMBER_BYTES).as_bytes(), &mut wire)
        .unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert!(stream.request(&mut Vec::new()).is_some());
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    stream
        .respond(br#"{"kind":"value"}"#, b"0", &mut wire)
        .unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    let extra = PEAK.load(Ordering::Relaxed) - before;
    assert!(extra < 2 * NUMBER_BYTES, "{extra} extra literal bytes");
    assert!(wire.is_empty(), "{wire:?}");
}

fn format_allocations(input: &str, operation: &str, memory: usize) -> (usize, Vec<u8>) {
    runtime_allocations(
        input,
        &format!(". as $x | input | $x | {operation} | empty"),
        memory,
        7,
    )
}

fn runtime_allocations(input: &str, program: &str, memory: usize, steps: u64) -> (usize, Vec<u8>) {
    configured_allocations(
        input,
        serde_json::json!({
            "program": program,
            "steps": steps,
            "memory": memory,
        }),
    )
}

fn configured_allocations(input: &str, config: serde_json::Value) -> (usize, Vec<u8>) {
    let config = serde_json::to_vec(&config).unwrap();
    let mut stream = mirage_rs::open("jq_eval", &config).unwrap();
    let mut wire = Vec::new();
    stream.feed(input.as_bytes(), &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert!(stream.request(&mut Vec::new()).is_some());
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    stream
        .respond(br#"{"kind":"value"}"#, b"0", &mut wire)
        .unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    (PEAK.load(Ordering::Relaxed) - before, wire)
}

#[test]
fn caught_conversion_errors_keep_the_string_and_array_buffer_peak() {
    let _serial = SERIAL.lock().unwrap();
    let input = format!("\"{}\"", "x".repeat(NAME_BYTES));
    for steps in [7, u64::MAX] {
        for (operation, limit, memory) in [
            ("$x + $x", "bytes", 260000),
            ("$x | explode", "items", 1000000),
        ] {
            let mut config = serde_json::json!({
                "program": ". as $x | input | $x | empty",
                "steps": steps,
                "memory": memory,
            });
            config[limit] = 1.into();
            let (_, wire) = configured_allocations(&input, config.clone());
            assert!(wire.is_empty(), "{operation} control: {wire:?}");
            config["program"] =
                format!(". as $x | input | try ({operation}) catch empty | empty").into();
            let (extra, wire) = configured_allocations(&input, config);
            assert!(
                extra + NAME_BYTES > memory,
                "{operation}: {extra} extra bytes"
            );
            assert_eq!(wire.first(), Some(&2), "{operation}: {extra} extra bytes");
            assert!(String::from_utf8_lossy(&wire[5..]).contains("memory limit"));
        }
    }
}

#[test]
fn runtime_string_capacity_peaks_cannot_bypass_the_memory_cap() {
    let _serial = SERIAL.lock().unwrap();
    const POINTS: usize = 32768;
    let retained = POINTS * std::mem::size_of::<usize>() * 3;
    for steps in [7, u64::MAX] {
        for (source, operation) in [
            ("[range(32768) | 8364]", "implode"),
            (
                "[range(32768) | if . == 32767 then null else 8364 end]",
                "try implode catch empty",
            ),
        ] {
            for memory in [900000, 950000] {
                let control = format!("{source} as $x | input | $x | empty");
                let (_, wire) = runtime_allocations("null", &control, memory, steps);
                assert!(wire.is_empty(), "control at {memory}: {wire:?}");
                let program = format!("{source} as $x | input | $x | {operation} | empty");
                let (extra, wire) = runtime_allocations("null", &program, memory, steps);
                assert!(extra >= POINTS * 3, "{operation}: {extra} extra bytes");
                if retained + extra > memory {
                    assert_eq!(wire.first(), Some(&2), "{operation}: {extra} extra bytes");
                    assert!(String::from_utf8_lossy(&wire[5..]).contains("memory limit"));
                } else {
                    assert!(wire.is_empty(), "{operation}: {wire:?}");
                }
            }
        }
    }
}

#[test]
fn formatters_do_not_clone_their_string_sources() {
    let _serial = SERIAL.lock().unwrap();
    let text = format!("\"{}\"", "x".repeat(NAME_BYTES));
    let base64 = format!("\"{}\"", "eHh4".repeat(NAME_BYTES / 3));
    for (input, operation, source_bytes) in [
        (text.as_str(), "@uri", NAME_BYTES),
        (text.as_str(), "@urid", NAME_BYTES),
        (text.as_str(), "@base64", NAME_BYTES),
        (text.as_str(), "@html", NAME_BYTES),
        (text.as_str(), "[$x] | @csv", NAME_BYTES),
        (text.as_str(), "[$x] | @tsv", NAME_BYTES),
        (text.as_str(), "[$x] | @sh", NAME_BYTES),
        (base64.as_str(), "@base64d", NAME_BYTES / 3 * 4),
    ] {
        let (extra, wire) = format_allocations(input, operation, 1_000_000);
        assert!(extra < 2 * source_bytes, "{operation}: {extra} extra bytes");
        assert!(wire.is_empty(), "{operation}: {wire:?}");
    }
}

#[test]
fn formatter_allocation_peaks_cannot_bypass_the_memory_cap() {
    let _serial = SERIAL.lock().unwrap();
    let text = format!("\"{}\"", "x".repeat(NAME_BYTES));
    let lossy = format!("\"{}\"", "/".repeat(NAME_BYTES / 3 * 4));
    for (input, operation, source_bytes, cap) in [
        (text.as_str(), "@uri", NAME_BYTES, 260000),
        (text.as_str(), "@base64", NAME_BYTES, 260000),
        (lossy.as_str(), "@base64d", NAME_BYTES / 3 * 4, 500000),
    ] {
        let (_, control) = format_allocations(input, ".", cap);
        assert!(control.is_empty(), "{operation} control: {control:?}");
        let (extra, wire) = format_allocations(input, operation, cap);
        if extra + source_bytes > cap {
            assert_eq!(wire.first(), Some(&2), "{operation}: {extra} extra bytes");
            assert!(String::from_utf8_lossy(&wire[5..]).contains("memory limit"));
        } else {
            assert!(wire.is_empty(), "{operation}: {wire:?}");
        }
    }
}
