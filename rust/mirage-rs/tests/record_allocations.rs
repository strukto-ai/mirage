use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountAlloc;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

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
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let replacement = unsafe { System.realloc(ptr, layout, new_size) };
        if !replacement.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            allocated(new_size);
        }
        replacement
    }
}
#[global_allocator]
static ALLOCATOR: CountAlloc = CountAlloc;

#[test]
fn short_records_bound_allocation_volume_and_live_input() {
    let data = b"a\n".repeat(32768);
    let mut stream = mirage_rs::open("rg", br#"{"pattern":"z"}"#).unwrap();
    stream.begin(b"{}").unwrap();
    let mut out = Vec::new();
    ALLOCATED.store(0, Ordering::Relaxed);
    stream.feed(&data, &mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    let allocated = ALLOCATED.load(Ordering::Relaxed);
    assert!(out.is_empty());
    assert_eq!(stream.status(), 1);
    let mut metadata = Vec::new();
    stream.metadata(&mut metadata);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&metadata).unwrap()["searched"],
        data.len()
    );
    assert!(
        allocated < data.len() * 128,
        "short records allocated {allocated} bytes for {} input bytes",
        data.len()
    );

    const CHUNK: usize = 64 * 1024;
    let records = CHUNK * 8;
    let data = [b"x".to_vec(), b"a\n".repeat(records)].concat();
    let mut stream =
        mirage_rs::open("rg", br#"{"pattern":"a","count_only":true,"stats":true}"#).unwrap();
    stream.begin(b"{}").unwrap();
    let mut out = Vec::new();
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    for chunk in data.chunks(CHUNK) {
        stream.feed(chunk, &mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
    }
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    assert_eq!(out, format!("{records}\n").as_bytes());
    assert_eq!(stream.status(), 0);
    let mut metadata = Vec::new();
    stream.metadata(&mut metadata);
    let metadata: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    assert_eq!(metadata["searched"], data.len());
    assert_eq!(metadata["matches"], records);
    assert_eq!(metadata["matched_lines"], records);
    assert!(
        peak < CHUNK * 8,
        "unaligned records retained {peak} live bytes for {} input bytes",
        data.len(),
    );
}
