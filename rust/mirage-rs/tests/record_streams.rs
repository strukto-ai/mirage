use mirage_rs::open;
use serde_json::{Value, json};

fn join_config() -> Value {
    json!({"keys":[0,0],"unpaired":[false,false],"paired":true,"filler":null,"columns":[],
        "auto_columns":false,"delimiter":null,"separator":" ","fold_case":false,
        "terminator":10,"order":"warn","header":false,"names":["left","right"]})
}

fn comm_config() -> Value {
    json!({"suppressed":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"terminator":10})
}

fn run(kind: &str, config: &Value, inputs: [&[u8]; 2], size: usize) -> (Vec<u8>, Vec<u8>, i32) {
    let mut stream = open(kind, &serde_json::to_vec(config).unwrap()).unwrap();
    let mut offsets = [0; 2];
    let mut output = Vec::new();
    let mut error = Vec::new();
    let mut calls = 0;
    loop {
        calls += 1;
        assert!(calls < 2_000_000, "stream must make progress");
        let mut piece = Vec::new();
        if stream.busy() {
            stream.drain(&mut piece).unwrap();
        } else if let Some(side) = stream.wants() {
            let offset = offsets[side];
            if offset == inputs[side].len() {
                stream.end_input(side, &mut piece).unwrap();
            } else {
                let end = (offset + size).min(inputs[side].len());
                stream
                    .feed_input(side, &inputs[side][offset..end], &mut piece)
                    .unwrap();
                offsets[side] = end;
            }
        } else {
            break;
        }
        assert!(piece.len() <= 16 * 1024, "bounded output per call");
        output.extend(piece);
        stream.take_stderr(&mut error);
    }
    let mut piece = Vec::new();
    stream.finish(&mut piece).unwrap();
    assert!(piece.len() <= 16 * 1024);
    output.extend(piece);
    stream.take_stderr(&mut error);
    while stream.busy() {
        let mut piece = Vec::new();
        stream.drain(&mut piece).unwrap();
        assert!(piece.len() <= 16 * 1024);
        output.extend(piece);
        stream.take_stderr(&mut error);
    }
    (output, error, stream.status())
}

#[test]
fn join_products_keep_left_major_order_at_every_chunk_size() {
    for size in 1..=32 {
        assert_eq!(
            run(
                "join",
                &join_config(),
                [b"a 1\na 2\nb 3", b"a x\na y\na z\nc q\n"],
                size
            ),
            (
                b"a 1 x\na 1 y\na 1 z\na 2 x\na 2 y\na 2 z\n".to_vec(),
                vec![],
                0
            )
        );
    }
}

#[test]
fn join_strict_disorder_in_lookahead_refuses_before_group_output() {
    let mut config = join_config();
    config["order"] = json!("fail");
    for size in 1..=12 {
        assert_eq!(
            run("join", &config, [b"a 1\na 2\n0 bad\n", b"a x\n"], size),
            (vec![], b"join: left:3: is not sorted: 0 bad\n".to_vec(), 1)
        );
    }
}

#[test]
fn join_default_order_trigger_follows_the_unpaired_advance() {
    assert_eq!(
        run(
            "join",
            &join_config(),
            [b"a 1\nc 2\nb 3\n", b"a x\nz q\n"],
            1
        ),
        (b"a 1 x\n".to_vec(), vec![], 0)
    );
}

#[test]
fn join_headers_and_raw_bytes_keep_original_spelling() {
    let mut config = join_config();
    config["header"] = json!(true);
    assert_eq!(
        run("join", &config, [b"name value\n", b""], 1),
        (b"name value\n".to_vec(), vec![], 0)
    );
    config["header"] = json!(false);
    assert_eq!(
        run("join", &config, [b"a \xff\n", b"a \xfe\n"], 1),
        (b"a \xff \xfe\n".to_vec(), vec![], 0)
    );
}

#[test]
fn join_giant_record_and_cartesian_output_are_drained_in_bounded_pieces() {
    let mut left = vec![b'x'; 2 * 1024 * 1024];
    left.extend_from_slice(b" a\n");
    let mut right = vec![b'x'; 2 * 1024 * 1024];
    right.extend_from_slice(b" b\n");
    let (output, error, status) = run("join", &join_config(), [&left, &right], 16 * 1024);
    let mut expected = vec![b'x'; 2 * 1024 * 1024];
    expected.extend_from_slice(b" a b\n");
    assert_eq!(output, expected);
    assert!(error.is_empty());
    assert_eq!(status, 0);
    let left = b"k a\n".repeat(300);
    let right = b"k b\n".repeat(300);
    let (output, error, status) = run("join", &join_config(), [&left, &right], 16 * 1024);
    assert_eq!(output, b"k a b\n".repeat(90_000));
    assert!(error.is_empty());
    assert_eq!(status, 0);
}

#[test]
fn comm_columns_totals_and_order_checks_survive_arbitrary_chunks() {
    let mut config = comm_config();
    config["total"] = json!(true);
    for size in 1..=16 {
        assert_eq!(
            run("comm", &config, [b"a\nb\nd\n", b"b\nc\nd\n"], size),
            (
                b"a\n\t\tb\n\tc\n\t\td\n1\t1\t2\ttotal\n".to_vec(),
                vec![],
                0
            )
        );
    }
    config["check_order"] = json!(true);
    assert_eq!(
        run("comm", &config, [b"b\na\n", b"z\n"], 1),
        (
            b"b\n".to_vec(),
            b"comm: file 1 is not in sorted order\n".to_vec(),
            1
        )
    );
}

#[test]
fn comm_keeps_replacement_decoding_and_bounds_giant_records() {
    for size in 1..=8 {
        assert_eq!(
            run("comm", &comm_config(), [b"\xe1\x80\n", b"\xff\n"], size),
            ("\t\t\u{fffd}\n".as_bytes().to_vec(), vec![], 0)
        );
    }
    let record = vec![b'a'; 2 * 1024 * 1024];
    let (output, error, status) = run("comm", &comm_config(), [&record, &record], 16 * 1024);
    let mut expected = b"\t\t".to_vec();
    expected.extend_from_slice(&record);
    expected.push(b'\n');
    assert_eq!(output, expected);
    assert!(error.is_empty());
    assert_eq!(status, 0);
}

#[test]
fn cancellation_retires_partial_and_queued_records_without_output() {
    for (kind, config) in [("join", join_config()), ("comm", comm_config())] {
        for terminated in [false, true] {
            let mut stream = open(kind, &serde_json::to_vec(&config).unwrap()).unwrap();
            let input = vec![b'a'; 2 * 1024 * 1024];
            let mut output = Vec::new();
            for chunk in input.chunks(16 * 1024) {
                stream.feed_input(0, chunk, &mut output).unwrap();
                while stream.busy() {
                    stream.drain(&mut output).unwrap();
                }
            }
            if terminated {
                stream.feed_input(0, b"\n", &mut output).unwrap();
                stream.drain(&mut output).unwrap();
            }
            assert!(stream.cancel());
            assert!(stream.cancel());
            let mut calls = 0;
            while stream.busy() {
                output.clear();
                stream.drain(&mut output).unwrap();
                assert!(output.is_empty());
                calls += 1;
                assert!(calls < 10_000, "cancelled stream must retire its records");
            }
            assert!(stream.done());
            assert_eq!(stream.wants(), None);
        }
    }
}
