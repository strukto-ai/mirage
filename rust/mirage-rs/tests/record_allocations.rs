use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
static LIVE: AtomicUsize = AtomicUsize::new(0);
static FREES: AtomicUsize = AtomicUsize::new(0);
struct Counter;
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        FREES.fetch_add(1, Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            LIVE.fetch_sub(l.size(), Ordering::Relaxed);
            LIVE.fetch_add(n, Ordering::Relaxed);
        }
        q
    }
}
#[global_allocator]
static ALLOC: Counter = Counter;
#[test]
fn short_records_and_group_retirement_stay_bounded() {
    for n in [2000, 10000] {
        let config=br#"{"keys":[0,0],"unpaired":[false,false],"paired":false,"filler":null,"columns":[],"auto_columns":false,"delimiter":null,"separator":" ","fold_case":false,"terminator":10,"order":"off","header":false,"names":["left","right"]}"#;
        let left = b"k x\n".repeat(n);
        let right = b"k y\n".to_vec();
        let inputs = [left.as_slice(), right.as_slice()];
        let before = LIVE.load(Ordering::Relaxed);
        let mut stream = mirage_rs::open("join", config).unwrap();
        let mut offsets = [0usize; 2];
        let mut out = Vec::new();
        let mut peak = 0;
        let mut max_frees = 0;
        let mut max_call = String::new();
        loop {
            FREES.store(0, Ordering::Relaxed);
            let action;
            if stream.busy() {
                action = "drain".to_owned();
                stream.drain(&mut out).unwrap();
            } else if let Some(side) = stream.wants() {
                if offsets[side] == inputs[side].len() {
                    action = format!("end_input({side})");
                    stream.end_input(side, &mut out).unwrap();
                } else {
                    action = format!("feed_input({side})");
                    let end = (offsets[side] + 16384).min(inputs[side].len());
                    stream
                        .feed_input(side, &inputs[side][offsets[side]..end], &mut out)
                        .unwrap();
                    offsets[side] = end;
                }
            } else {
                break;
            }
            let frees = FREES.load(Ordering::Relaxed);
            if frees > max_frees {
                max_frees = frees;
                max_call = action;
            }
            peak = peak.max(LIVE.load(Ordering::Relaxed) - before);
        }
        assert_eq!(out.len(), 0);
        assert_eq!(stream.status(), 0);
        assert!(
            peak < n * 2048 + 1024 * 1024,
            "short record storage must not reserve a full chunk per row: {peak}"
        );
        assert!(
            max_frees <= 32768,
            "retirement must yield between batches: {max_frees} in {max_call}"
        );
    }
    for (kind, config) in [
        ("join", br#"{"keys":[0,0],"unpaired":[false,false],"paired":true,"filler":null,"columns":[],"auto_columns":false,"delimiter":null,"separator":" ","fold_case":false,"terminator":10,"order":"off","header":false,"names":["left","right"]}"#.as_slice()),
        ("comm", br#"{"suppressed":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"terminator":10}"#.as_slice()),
    ] {
        let input = vec![b'a'; 8 * 1024 * 1024];
        let before = LIVE.load(Ordering::Relaxed);
        let mut stream = mirage_rs::open(kind, config).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(16384) {
            stream.feed_input(0, chunk, &mut output).unwrap();
            while stream.busy() {
                stream.drain(&mut output).unwrap();
            }
        }
        FREES.store(0, Ordering::Relaxed);
        assert!(stream.cancel());
        assert!(FREES.load(Ordering::Relaxed) <= 32768);
        while stream.busy() {
            FREES.store(0, Ordering::Relaxed);
            output.clear();
            stream.drain(&mut output).unwrap();
            assert!(output.is_empty());
            assert!(FREES.load(Ordering::Relaxed) <= 32768);
        }
        assert!(LIVE.load(Ordering::Relaxed) < before + 65536);
    }
}
