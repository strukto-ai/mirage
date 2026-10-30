use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountAlloc;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static ALLOCATION_CALLS: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static LARGEST_REALLOC: AtomicUsize = AtomicUsize::new(0);

fn allocated(size: usize) {
    ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
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
            LARGEST_REALLOC.fetch_max(new_size, Ordering::Relaxed);
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            allocated(new_size);
        }
        replacement
    }
}
#[global_allocator]
static ALLOCATOR: CountAlloc = CountAlloc;

fn short_record_allocations(config: &[u8], data: &[u8], expected: &[u8]) -> usize {
    let mut stream = mirage_rs::open("rg", config).unwrap();
    stream.begin(b"{}").unwrap();
    let mut out = Vec::new();
    ALLOCATION_CALLS.store(0, Ordering::Relaxed);
    for chunk in data.chunks(16 * 1024) {
        stream.feed(chunk, &mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
    }
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    let calls = ALLOCATION_CALLS.load(Ordering::Relaxed);
    assert_eq!(out, expected);
    assert_eq!(stream.status(), i32::from(expected.is_empty()));
    let mut metadata = Vec::new();
    stream.metadata(&mut metadata);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&metadata).unwrap()["searched"],
        data.len(),
    );
    calls
}

fn filter_memory(kind: &str, config: &[u8], begin: &[u8], chunk: &[u8], bytes: usize) {
    let mut stream = mirage_rs::open(kind, config).unwrap();
    if kind != "cat" {
        stream.begin(begin).unwrap();
    }
    let mut out = Vec::new();
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    for _ in 0..bytes / chunk.len() {
        out.clear();
        stream.feed(chunk, &mut out).unwrap();
        while stream.busy() {
            out.clear();
            stream.drain(&mut out).unwrap();
        }
    }
    out.clear();
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        out.clear();
        stream.drain(&mut out).unwrap();
    }
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    assert!(
        peak < 2 * 1024 * 1024,
        "{kind} retained {peak} live bytes while processing {bytes} input bytes",
    );
    assert_eq!(stream.status(), 0);
}

#[test]
fn short_records_bound_allocation_volume_and_live_input() {
    diff_releases_finished_inputs();
    comparison_rows_stay_bounded();
    checksum_lists_stay_bounded();
    giant_record_capacity_is_released();
    for (kind, config) in [
        ("wc", br#"{"lines":false,"words":true,"bytes":false,"chars":false,"max_line_length":false}"#.as_slice()),
        ("cut", br#"{"list":"2","mode":"fields","delimiter":[44],"complement":false,"only_delimited":false,"whitespace":null,"no_partial":false,"output_delimiter":null,"zero_terminated":false}"#),
        ("uniq", br#"{"count":true,"repeated":false,"unique":false,"skip_fields":0,"skip_chars":0,"check_chars":null,"ignore_case":true,"all_repeated":null,"group":null,"zero_terminated":false}"#),
    ] { hot_loop_allocations(kind, config, b"alpha,theta,words\n"); }
    for bytes in [4 * 1024 * 1024, 64 * 1024 * 1024] {
        scatter_memory(bytes);
    }
    shuffle_plan_memory();
    let row = [b"theta,\x80,".as_slice(), &vec![b'x'; 1015], b"\n"].concat();
    let rows = row.repeat(16);
    let unended = vec![255; 16 * 1024];
    for bytes in [4 * 1024 * 1024, 64 * 1024 * 1024] {
        filter_memory("cat", br#"{"number_lines":true}"#, b"{}", &rows, bytes);
        filter_memory(
            "cat",
            br#"{"show_nonprinting":true}"#,
            b"{}",
            &unended,
            bytes,
        );
        filter_memory(
            "grep",
            br#"{"patterns":["theta"],"syntax":"basic","count":true}"#,
            br#"{"label":"f"}"#,
            &rows,
            bytes,
        );
        for mode in ["convert", "quit"] {
            let begin = format!(r#"{{"binary_mode":"{mode}","encoding":"windows-1252"}}"#);
            filter_memory(
                "rg",
                br#"{"pattern":"theta","count_only":true}"#,
                begin.as_bytes(),
                &rows,
                bytes,
            );
        }
    }

    for records in [16_384, 131_072] {
        for (config, row, expected) in [
            (
                br#"{"pattern":"z"}"#.as_slice(),
                b"a\n".as_slice(),
                Vec::new(),
            ),
            (
                br#"{"pattern":"a","count_only":true}"#.as_slice(),
                b"a\n".as_slice(),
                format!("{records}\n").into_bytes(),
            ),
            (
                br#"{"pattern":"a","count_matches":true}"#.as_slice(),
                b"a\nz\n".as_slice(),
                format!("{records}\n").into_bytes(),
            ),
        ] {
            let data = row.repeat(records);
            let calls = short_record_allocations(config, &data, &expected);
            let chunks = data.len().div_ceil(16 * 1024);
            assert!(
                calls < chunks * 32 + 128,
                "{records} short records used {calls} allocation calls across {chunks} chunks",
            );
        }
    }

    for (config, oversized, short, expected) in [
        (
            br#"{"pattern":"z","count_only":true}"#.as_slice(),
            [vec![b'x'; 512 * 1024], b"\n".to_vec()].concat(),
            b"x\n".repeat(32_768),
            Vec::new(),
        ),
        (
            br#"{"pattern":"a","count_matches":true}"#.as_slice(),
            [vec![b'a'; 32_768], b"\n".to_vec()].concat(),
            b"a\n".repeat(32_768),
            b"65537\n".to_vec(),
        ),
    ] {
        let mut stream = mirage_rs::open("rg", config).unwrap();
        stream.begin(b"{}").unwrap();
        let mut out = Vec::new();
        stream.feed(b"a\n", &mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        let baseline = LIVE.load(Ordering::Relaxed);
        for phase in [&oversized, &short] {
            for chunk in phase.chunks(16 * 1024) {
                stream.feed(chunk, &mut out).unwrap();
                while stream.busy() {
                    stream.drain(&mut out).unwrap();
                }
            }
            let retained = LIVE.load(Ordering::Relaxed).saturating_sub(baseline);
            assert!(
                retained < 96 * 1024 * 8,
                "discarded oversized record retained {retained} bytes after {} input bytes for {}",
                phase.len(),
                String::from_utf8_lossy(config),
            );
        }
        stream.finish(&mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        assert_eq!(out, expected);
    }

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

    const RECORD: usize = 70_000;
    let data = [vec![b'a'; RECORD], b"\r\nx\r\n".to_vec()].concat();
    let mut stream = mirage_rs::open(
        "rg",
        br#"{"pattern":"\\r","multiline":true,"crlf":true,"count_only":true}"#,
    )
    .unwrap();
    stream.begin(b"{}").unwrap();
    let mut out = Vec::new();
    LARGEST_REALLOC.store(0, Ordering::Relaxed);
    stream.feed(&data, &mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    let largest = LARGEST_REALLOC.load(Ordering::Relaxed);
    assert_eq!(out, b"2\r\n");
    assert_eq!(stream.status(), 0);
    assert!(
        largest < RECORD,
        "CRLF record selection reallocated {largest} bytes for a {RECORD}-byte record",
    );
}

fn hot_loop_allocations(kind: &str, config: &[u8], row: &[u8]) {
    let input = row.repeat(4096);
    let mut stream = mirage_rs::open(kind, config).unwrap();
    let mut out = Vec::new();
    stream
        .feed(&input[..16384.min(input.len())], &mut out)
        .unwrap();
    while stream.busy() {
        out.clear();
        stream.drain(&mut out).unwrap();
    }
    ALLOCATION_CALLS.store(0, Ordering::Relaxed);
    for chunk in input.chunks(16384) {
        out.clear();
        stream.feed(chunk, &mut out).unwrap();
        while stream.busy() {
            out.clear();
            stream.drain(&mut out).unwrap();
        }
    }
    let allocations = ALLOCATION_CALLS.load(Ordering::Relaxed);
    assert!(
        allocations < 100,
        "{kind}: {allocations} allocations for 4096 records"
    );
}

fn scatter_memory(bytes: usize) {
    let config = format!(r#"{{"mode":"scatter","separator":10,"size":{bytes}}}"#);
    let mut stream = mirage_rs::open("shuf", config.as_bytes()).unwrap();
    let chunk = [b"x".repeat(4095), b"\n".to_vec()].concat().repeat(4);
    let mut out = Vec::new();
    let mut payload = Vec::new();
    let mut bucket = 0u64;
    let mut writes = 0;
    let mut written = 0;
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    loop {
        while stream.busy() {
            out.clear();
            stream.drain(&mut out).unwrap();
            assert!(out.is_empty());
        }
        payload.clear();
        let Some(request) = stream.request(&mut payload) else {
            break;
        };
        let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
        let data = match request["op"].as_str().unwrap() {
            "read" => chunk.clone(),
            "random" => (0..request["count"].as_u64().unwrap())
                .flat_map(|_| {
                    let next = bucket.to_le_bytes();
                    bucket = (bucket + 1) % 16;
                    next
                })
                .collect(),
            "write" => {
                assert!(payload.len() <= 16 * 1024);
                writes += 1;
                written += payload.len();
                Vec::new()
            }
            _ => unreachable!(),
        };
        stream.respond(b"{}", &data, &mut out).unwrap();
    }
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    assert_eq!(written, bytes);
    assert_eq!(writes, bytes / (16 * 1024));
    assert!(
        peak < 1024 * 1024,
        "shuf: {peak} live bytes for {bytes} bytes of input"
    );
}

fn shuffle_plan_memory() {
    let record = 17 * 1024 * 1024 + 1usize;
    let config = serde_json::json!({"mode":"records", "separator":10, "size":2*record, "available":2, "need":1}).to_string();
    let mut stream = mirage_rs::open("shuf", config.as_bytes()).unwrap();
    let mut spools = std::collections::HashMap::<u64, Vec<u8>>::from([(0, Vec::new())]);
    let mut out = Vec::new();
    let mut payload = Vec::new();
    let mut emitted = 0;
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    loop {
        while stream.busy() {
            stream.drain(&mut out).unwrap();
            assert!(out.len() <= 16384);
            emitted += out.len();
            out.clear();
        }
        payload.clear();
        let Some(header) = stream.request(&mut payload) else {
            break;
        };
        let request: serde_json::Value = serde_json::from_slice(&header).unwrap();
        let id = request["spool"].as_u64().unwrap_or(0);
        let response = match request["op"].as_str().unwrap() {
            "random" => vec![0; request["count"].as_u64().unwrap() as usize * 8],
            "write" => {
                let stored = spools.entry(id).or_default();
                if payload.iter().any(|byte| !matches!(*byte, b'x' | b'\n')) {
                    stored.extend_from_slice(&payload);
                }
                Vec::new()
            }
            "close" => {
                spools.remove(&id);
                Vec::new()
            }
            "read" => {
                let offset = request["offset"].as_u64().unwrap() as usize;
                let size = request["size"].as_u64().unwrap() as usize;
                let stored = spools.get(&id).unwrap();
                if stored.is_empty() {
                    let mut data = vec![b'x'; size];
                    let first = record - 1 - offset % record;
                    for at in (first..size).step_by(record) {
                        data[at] = b'\n';
                    }
                    data
                } else {
                    stored[offset..offset + size].to_vec()
                }
            }
            _ => unreachable!(),
        };
        stream.respond(b"{}", &response, &mut out).unwrap();
        assert!(out.len() <= 16384);
        emitted += out.len();
        out.clear();
    }
    assert_eq!(emitted, record);
    assert!(spools.is_empty());
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    assert!(
        peak < 1024 * 1024,
        "shuf plan: {peak} live bytes for two 17 MiB records"
    );
}

fn comparison_rows_stay_bounded() {
    let bytes = 34 * 1024 * 1024;
    let config = serde_json::json!({"names":["a","b"],"piped":[false,false],"skip":[0,0],"limit":null,"verbose":true,"sizes":[bytes,bytes]});
    let mut stream = mirage_rs::open("cmp", &serde_json::to_vec(&config).unwrap()).unwrap();
    let chunks = [vec![b'a'; 16 * 1024], vec![b'b'; 16 * 1024]];
    let mut read = [0; 2];
    let mut out = Vec::new();
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    let mut rows = 0;
    while let Some(side) = stream.wants() {
        out.clear();
        if read[side] < bytes {
            stream.feed_input(side, &chunks[side], &mut out).unwrap();
            read[side] += chunks[side].len();
        } else {
            stream.end_input(side, &mut out).unwrap();
        }
        rows += memchr::memchr_iter(b'\n', &out).count();
        while stream.busy() {
            out.clear();
            stream.drain(&mut out).unwrap();
            assert!(out.len() <= 64 * 1024 + 32);
            rows += memchr::memchr_iter(b'\n', &out).count();
        }
        if read.iter().all(|n| *n >= 16 * 1024) {
            assert!(rows > 0, "cmp must print before EOF");
        }
    }
    assert_eq!(rows, bytes);
    assert_eq!(stream.status(), 1);
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    assert!(peak < 1024 * 1024, "cmp retained {peak} bytes");
}

fn checksum_lists_stay_bounded() {
    let row = format!("{}  file\n", "a".repeat(64));
    let input = row.repeat(200).into_bytes();
    let mut stream =
        mirage_rs::open("digest", br#"{"algorithm":"sha256","check_lines":true}"#).unwrap();
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    let mut out = Vec::new();
    let mut records = 0;
    for _ in 0..2500 {
        out.clear();
        stream.feed(&input, &mut out).unwrap();
        records += memchr::memchr_iter(b'\n', &out).count();
        while stream.busy() {
            out.clear();
            stream.drain(&mut out).unwrap();
            records += memchr::memchr_iter(b'\n', &out).count();
        }
    }
    out.clear();
    stream.finish(&mut out).unwrap();
    records += memchr::memchr_iter(b'\n', &out).count();
    assert_eq!(records, 500_000);
    assert!(input.len() * 2500 > 32 * 1024 * 1024);
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    assert!(peak < 1024 * 1024, "checksum parser retained {peak} bytes");
}

fn giant_record_capacity_is_released() {
    let mut stream = mirage_rs::open("uniq", br#"{"count":false,"repeated":false,"unique":false,"skip_fields":0,"skip_chars":0,"check_chars":null,"ignore_case":false,"all_repeated":null,"group":null,"zero_terminated":false}"#).unwrap();
    let input = vec![b'x'; 16 * 1024];
    let baseline = LIVE.load(Ordering::Relaxed);
    let mut out = Vec::new();
    for _ in 0..256 {
        stream.feed(&input, &mut out).unwrap();
    }
    stream.feed(b"\na\nb\nc\n", &mut out).unwrap();
    while stream.busy() {
        out.clear();
        stream.drain(&mut out).unwrap();
    }
    drop(out);
    let retained = LIVE.load(Ordering::Relaxed).saturating_sub(baseline);
    assert!(
        retained < 512 * 1024,
        "uniq kept {retained} bytes after replacing its giant record"
    );
}

fn diff_releases_finished_inputs() {
    let mut stream = mirage_rs::open("diff", br#"{"brief":true}"#).unwrap();
    let chunk = vec![b'x'; 16 * 1024];
    let baseline = LIVE.load(Ordering::Relaxed);
    let mut out = Vec::new();
    for side in 0..2 {
        for _ in 0..2176 {
            stream.feed_input(side, &chunk, &mut out).unwrap();
        }
        stream.end_input(side, &mut out).unwrap();
    }
    stream.finish(&mut out).unwrap();
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    assert_eq!(stream.status(), 0);
    let retained = LIVE.load(Ordering::Relaxed).saturating_sub(baseline);
    assert!(
        retained < 1024 * 1024,
        "diff kept {retained} bytes after completion"
    );
}
