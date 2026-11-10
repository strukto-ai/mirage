mod common;

use common::ALLOCATED;
use std::sync::atomic::Ordering;

#[test]
fn ordinary_and_quiet_searches_do_not_retain_unused_capture_rows() {
    for quiet in [false, true] {
        let config = serde_json::to_vec(&serde_json::json!({
            "pattern": "(a)".repeat(10_000),
            "quiet": quiet,
        }))
        .unwrap();
        let mut stream = mirage_rs::open("rg", &config).unwrap();
        stream.begin(b"{}").unwrap();
        let data = [vec![b'a'; 10_000], vec![b'\n']].concat();
        let mut out = Vec::new();
        ALLOCATED.store(0, Ordering::Relaxed);
        stream.feed(&data, &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        while stream.busy() {
            let allocated = ALLOCATED.load(Ordering::Relaxed);
            assert!(
                allocated < 16 * 1024 * 1024,
                "search requested {allocated} bytes"
            );
            stream.drain(&mut out).unwrap();
        }
        assert_eq!(stream.status(), 0);
        assert_eq!(out, if quiet { Vec::new() } else { data });
    }
}
