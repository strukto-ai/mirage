use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountAlloc;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

fn allocated(size: usize) {
    ALLOCATED.fetch_add(size, Ordering::Relaxed);
    let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            allocated(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let replacement = unsafe { System.realloc(ptr, layout, size) };
        if !replacement.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            allocated(size);
        }
        replacement
    }
}

#[global_allocator]
static ALLOCATOR: CountAlloc = CountAlloc;

fn runtime_compile_allocations(pattern: &str) -> (usize, usize) {
    let config = serde_json::json!({
        "program": "test($pattern)",
        "named": [["pattern", serde_json::to_string(pattern).unwrap()]],
    });
    let mut stream = mirage_rs::open("jq_eval", config.to_string().as_bytes()).unwrap();
    let mut out = Vec::new();
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    ALLOCATED.store(0, Ordering::Relaxed);
    stream.feed(b"\"aaaa\"", &mut out).unwrap();
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    let allocated = ALLOCATED.load(Ordering::Relaxed);
    assert_eq!(out, b"\x01\x05\0\0\0false");
    assert_eq!(stream.status(), 0);
    (peak, allocated)
}

#[test]
fn recursive_call_checks_bound_compile_allocations() {
    let groups = 768;
    let pattern: String = (0..groups)
        .map(|i| format!("(?<w{i}>(?<g{i}>a\\g<g{}>?))", (i + 1) % groups))
        .collect();
    let (peak, allocated) = runtime_compile_allocations(&pattern);
    assert!(
        peak < 4 << 20,
        "wrapped cycle retained {peak} additional bytes"
    );
    assert!(
        allocated < 512 << 20,
        "wrapped cycle allocated {allocated} bytes"
    );

    let pattern = format!("(?<x>a\\g<r>?){{0}}(?<r>{})", "\\g<x>".repeat(16384));
    let (peak, allocated) = runtime_compile_allocations(&pattern);
    assert!(
        peak < 32 << 20,
        "repeated calls retained {peak} additional bytes"
    );
    assert!(
        allocated < 128 << 20,
        "repeated calls allocated {allocated} bytes"
    );
}
