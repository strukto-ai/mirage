use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountAlloc;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATED.fetch_add(new_size, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}
#[global_allocator]
static ALLOCATOR: CountAlloc = CountAlloc;

#[test]
fn short_records_do_not_reallocate_the_remaining_input() {
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
}
